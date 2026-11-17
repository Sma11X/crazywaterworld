import type { LoginSettingsMount } from "./pages/login-settings";

const host = document.getElementById("login-settings-root");
const section = document.getElementById("tab-login-settings");

if (host && section) {
  let mounted: LoginSettingsMount | undefined;
  let loading = false;
  let disposed = false;
  const active = () =>
    !section.classList.contains("hidden") && !document.hidden;
  const account = () => host.dataset.account || null;

  async function update() {
    if (disposed) return;
    if (mounted) {
      mounted.update(account(), active());
      return;
    }
    if (!active() || loading) return;
    loading = true;
    try {
      // Keep React, Radix and Day.js off the overview page's initial JS path.
      const { mountLoginSettings } = await import("./pages/login-settings");
      if (!disposed)
        mounted = mountLoginSettings(host as HTMLElement, account(), active());
    } catch {
      if (disposed) return;
      const message = document.createElement("p");
      message.setAttribute("role", "alert");
      message.textContent =
        "登录设置页面加载失败，请重试；更新程序后请刷新网页。";
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = "重新加载页面组件";
      retry.addEventListener("click", () => {
        void update();
      });
      host?.replaceChildren(message, retry);
    } finally {
      loading = false;
    }
  }

  const observer = new MutationObserver(() => {
    void update();
  });
  observer.observe(host, {
    attributes: true,
    attributeFilter: ["data-account"],
  });
  observer.observe(section, { attributes: true, attributeFilter: ["class"] });
  document.addEventListener("visibilitychange", update);
  window.addEventListener("pagehide", (event) => {
    if (event.persisted) return;
    disposed = true;
    observer.disconnect();
    document.removeEventListener("visibilitychange", update);
    mounted?.unmount();
  });
  void update();
}
