// 隔离账号与本机临时HTTP端口；只测试配置，不建立游戏连接。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cw-speed-browser-'));
process.env.CW_DATA_DIR=directory;process.env.CW_CONFIG_PACK=path.join(directory,'config.json');
fs.writeFileSync(process.env.CW_CONFIG_PACK,JSON.stringify([[1,'BuildingUnlockCfg',{data:[1,2,3].map(i=>({buildingType:'远征船',buildingId:i+'远征船'}))}]]));
const {saveStore}=await import('../src/accounts.mjs');
const {defaultSettings,saveAutomationSettings,loadAutomationSettings}=await import('../src/automation-settings.mjs');
const {createConsole}=await import('../src/server.mjs');
const {observeOwnedFleets}=await import('../src/fleet-catalog.mjs');
saveStore({activeId:'speed-browser',accounts:[{id:'speed-browser',label:'加速界面测试',url:'ws://invalid.invalid',login:{},automation:{enabled:false,paused:true}}]});
const settings=defaultSettings();settings.cityWar.enabled=true;settings.cityWar.fleetIds=['1远征船','2远征船'];settings.cityWar.defenceFleetIds=['2远征船'];
settings.fleetSpeed.enabled=true;Object.assign(settings.fleetSpeed.fleets[0],{repair:true,march:true,repairMaxDiamonds:50,marchMaxDiamonds:90});
saveAutomationSettings('speed-browser',settings,{revision:0});
const app=createConsole({port:0,protocol:{}}),base=await app.listen();let browser;const errors=[];
const executablePath=['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
try{
  await fetch(base+'/api/settings?account=speed-browser');const session=app.sessions.get('speed-browser');session.player={playerId:123,worldId:1001001};
  observeOwnedFleets(session,[{buildingId:'1远征船'},{buildingId:'2远征船'}],{complete:true});
  browser=await chromium.launch({executablePath,headless:true});fs.mkdirSync('output/fleet-speed',{recursive:true});
  for(const [name,viewport] of [['desktop',{width:1440,height:1000}],['mobile',{width:390,height:844}]]){
    const context=await browser.newContext({viewport,deviceScaleFactor:1}),page=await context.newPage();
    page.on('pageerror',error=>errors.push(error.message));await page.goto(base);
    await page.locator('#tabs [data-tab=settings]').click();await page.locator('[data-config-tab=world]').click();await page.locator('[data-config-group=cityWar]').click();
    const city=page.locator('#config-group-cityWar');
    assert.equal(await city.locator('.config-field-section[open]').count(),await city.locator('.config-field-section').count());
    assert.equal(await page.locator('#config-fields .config-disclosure[aria-expanded=true]').count(),0);
    assert.equal(await page.locator('[id^=config-field-fleetSpeed-fleets-2-]').count(),0);
    await city.screenshot({path:path.resolve('output/fleet-speed/default-levels-'+name+'.png')});
    // 模式切回已保存值时不再有保存请求，仍应立即移除上一模式的校验错误。
    for(const [mode,refs] of [['targetMode','cityRefs'],['defenceTargetMode','defenceCityRefs']]){
      const select=page.locator('#config-field-cityWar-'+mode),error=page.locator('#config-field-cityWar-'+refs+'-error');
      await select.selectOption('selected');await error.waitFor({state:'visible'});
      assert.match(await error.textContent(),/请至少选择一座/);
      await select.selectOption('alliance');
      assert.equal(await error.isVisible(),false);assert.equal(await page.locator('#config-field-cityWar-'+refs).isVisible(),false);
      assert.equal(await page.locator('#config-message').isVisible(),false);
      assert.match(await page.locator('#config-state').textContent(),/配置已同步/);
    }
    // 两项同时报错时，修正一项后只能显示另一项当前仍有效的错误。
    await page.locator('#config-field-cityWar-targetMode').selectOption('selected');
    await page.locator('#config-field-cityWar-defenceTargetMode').selectOption('selected');
    await page.locator('#config-field-cityWar-cityRefs-error').waitFor({state:'visible'});
    await page.locator('#config-field-cityWar-defenceCityRefs-error').waitFor({state:'visible'});
    await page.locator('#config-field-cityWar-targetMode').selectOption('alliance');
    await page.locator('#config-field-cityWar-defenceCityRefs-error').waitFor({state:'visible'});
    assert.equal(await page.locator('#config-field-cityWar-cityRefs-error').isVisible(),false);
    await page.locator('#config-field-cityWar-defenceTargetMode').selectOption('alliance');
    assert.equal(await page.locator('#config-message').isVisible(),false);
    assert.equal(loadAutomationSettings('speed-browser').settings.cityWar.targetMode,'alliance');
    assert.equal(loadAutomationSettings('speed-browser').settings.cityWar.defenceTargetMode,'alliance');
    const fleetSection=page.locator('#config-section-fleetSpeed-fleets-0-repair');
    const branch=mode=>page.locator('[data-config-branch="fleetSpeed.fleets.0.'+mode+'"]');
    const expand=async mode=>{await branch(mode).locator(':scope > .config-row .config-disclosure').click();};
    await expand('repair');await expand('march');
    const repair=page.locator('#config-field-fleetSpeed-fleets-0-repairSmartSave'),march=page.locator('#config-field-fleetSpeed-fleets-0-marchSmartSave');
    assert.equal(await repair.isVisible(),true);assert.equal(await march.isVisible(),true);
    assert.equal(await page.locator('#config-field-fleetSpeed-fleets-0-repairSmartWaitSeconds').isVisible(),false);
    if(name==='desktop'){
      await repair.uncheck();assert.equal(await march.isChecked(),true);
      await expand('marchSmartSave');await page.locator('#config-field-fleetSpeed-fleets-0-marchSmartWaitSeconds').fill('3');
      await page.locator('#config-field-fleetSpeed-fleets-0-marchSmartWaitSeconds').blur();
      await page.waitForFunction(()=>document.querySelector('#config-state')?.textContent.includes('配置已同步'));
      const saved=loadAutomationSettings('speed-browser').settings.fleetSpeed.fleets;
      assert.equal(saved[0].repairSmartSave,false);assert.equal(saved[0].marchSmartSave,true);assert.equal(saved[0].marchSmartWaitSeconds,3);
      assert.equal(saved[1].repairSmartSave,true);assert.equal(saved[1].marchSmartWaitSeconds,5);
      await page.reload();await page.locator('#tabs [data-tab=settings]').click();await page.locator('[data-config-tab=world]').click();await page.locator('[data-config-group=cityWar]').click();
      assert.equal(await city.locator('.config-field-section[open]').count(),await city.locator('.config-field-section').count());
      await expand('repair');await expand('march');
      assert.equal(await repair.isChecked(),false);assert.equal(await march.isChecked(),true);
      // 开启功能与展开配置是两件事；重新启用维修不会自动显示其参数。
      await expand('repair');const enable=page.locator('#config-field-fleetSpeed-fleets-0-repair');await enable.uncheck();await enable.check();
      assert.equal(await repair.isVisible(),false);await expand('repair');
    }
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    await fleetSection.scrollIntoViewIfNeeded();await page.screenshot({path:path.resolve('output/fleet-speed/independent-'+name+'.png'),fullPage:true});
    await page.locator('#config-section-cityWar-defenceTargetMode > summary').click();
    await page.locator('#config-field-cityWar-defenceFleetIds button').nth(1).click();
    assert.equal(await page.locator('#config-field-cityWar-defenceTargetMode').evaluate(node=>node===document.activeElement),true);
    assert.equal(await page.locator('#config-field-cityWar-defenceTargetMode').isVisible(),true);
    await context.close();console.log('通过：'+name+' 一级展开二级收起、攻守来源往返无残留错误、独立省钻、保存刷新与策略跳转，无横向溢出');
  }
  assert.deepEqual(errors,[]);assert.equal(session.client,null);assert.equal(session.loop.running,false);
  console.log('通过：全程零游戏连接与写入');
}finally{
  await browser?.close();app.server.closeAllConnections();await app.close();
  if(path.dirname(directory)!==path.resolve(os.tmpdir())||!path.basename(directory).startsWith('cw-speed-browser-'))throw Error('拒绝清理意外目录');
  fs.rmSync(directory,{recursive:true,force:true});
}
