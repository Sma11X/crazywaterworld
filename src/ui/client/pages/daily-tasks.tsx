import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { useStore } from "zustand";
import { Button } from "../../button";
import {
  type DailyTask,
  parseDailyOutcome,
  parseDailyTasks,
} from "../contracts/daily-tasks";
import { createAccountRequest } from "../lib/api";
import { type ConsoleState, getConsoleStore } from "../lib/console-store";
import styles from "./daily-tasks.module.css";

// A submitted action can outlive this view. Wait for it before rereading the same account.
const pending = new Map<string, Promise<string>>();

function connectionHint(state: ConsoleState) {
  const id = state.currentAccountId;
  if (!id) return "请先选择账号";
  const status = state.accountsById[id]?.status;
  if (status?.paused) return "账号已暂停，请先恢复托管";
  if (status?.reconnecting) return "账号正在重连";
  if (status?.loginBlocked || state.disconnected.has(id))
    return "请先连接当前账号";
  return "";
}

function statusLabel(task: DailyTask) {
  if (task.rewardClaimed) return "已领取";
  if (task.progress >= task.targetProgress) return "已达标";
  if (task.status === "partial" && task.action) return "部分可做";
  if (task.action) return "可执行";
  return task.status === "waiting" ? "等待中" : "暂无操作";
}

function TaskList({ account }: { account: string }) {
  const [tasks, setTasks] = useState<DailyTask[] | null>(null);
  const [busy, setBusy] = useState(true);
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  // biome-ignore lint/correctness/useExhaustiveDependencies: Manual refresh and settled writes both require a fresh survey.
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    async function read() {
      try {
        await pending.get(account)?.catch(() => {});
        signal.throwIfAborted();
        const data = await createAccountRequest(account)("/api/dailies", {
          signal,
        });
        if (!signal.aborted) setTasks(parseDailyTasks(data));
      } catch (err) {
        if (!signal.aborted) {
          setTasks(null);
          setError(err instanceof Error ? err.message : "读取日常任务失败");
        }
      } finally {
        if (!signal.aborted) setBusy(false);
      }
    }
    void read();
    return () => controller.abort();
  }, [account, revision]);

  function refresh() {
    setBusy(true);
    setError("");
    setRevision((n) => n + 1);
  }

  async function execute(task: DailyTask) {
    const action = task.action;
    const state = getConsoleStore().getState();
    if (
      !action ||
      busy ||
      pending.has(account) ||
      state.view.page !== "dailies" ||
      state.currentAccountId !== account ||
      connectionHint(state)
    )
      return;
    if (
      action.ruby &&
      !window.confirm(`花费 ${action.ruby} 钻石完成「${task.title}」？`)
    )
      return;
    setBusy(true);
    setError("");
    setNotice(`正在处理「${task.title}」…`);
    const job = createAccountRequest(account)("/api/dailies/single", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        confirm: true,
        token: action.token,
        paid: action.ruby > 0,
      }),
    }).then(parseDailyOutcome);
    pending.set(account, job);
    try {
      setNotice(await job);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "操作结果待确认");
    } finally {
      pending.delete(account);
      refresh();
    }
  }

  const completed = tasks?.filter(
    (t) => t.rewardClaimed || t.progress >= t.targetProgress,
  ).length;
  return (
    <>
      <div className="page-heading">
        <div className={styles.heading}>
          <h2>日常任务</h2>
          {tasks && (
            <span>
              已完成 {completed} / {tasks.length}
            </span>
          )}
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            setNotice("");
            refresh();
          }}
        >
          刷新进度
        </Button>
      </div>
      <p role="status" className={styles.notice}>
        {notice || (busy ? "正在读取任务进度…" : "")}
      </p>
      {error && <p role="alert">{error}</p>}
      {tasks &&
        (tasks.length === 0 ? (
          <p>当前账号暂无日常任务</p>
        ) : (
          <ul className={styles.list} aria-label="任务进度" aria-busy={busy}>
            {tasks.map((task) => (
              <li key={task.id} className={styles.row}>
                <div className={styles.task}>
                  <strong>{task.title}</strong>
                  <span className={styles.state}>{statusLabel(task)}</span>
                  {task.detail && <p>{task.detail}</p>}
                </div>
                <span className={styles.progress}>
                  {task.progress} / {task.targetProgress}
                  <progress
                    aria-label={`${task.title}进度`}
                    value={task.progress}
                    max={task.targetProgress || 1}
                  />
                </span>
                {task.action && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void execute(task)}
                  >
                    {task.action.label}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        ))}
    </>
  );
}

function DailyTasksPage() {
  const store = getConsoleStore();
  const active = useStore(store, (state) => state.view.page === "dailies");
  const account = useStore(store, (state) => state.currentAccountId);
  const hint = useStore(store, connectionHint);
  if (!active) return null;
  if (hint || !account)
    return (
      <>
        <div className="page-heading">
          <h2>日常任务</h2>
        </div>
        <p>{hint}</p>
      </>
    );
  return <TaskList key={account} account={account} />;
}

export function mountDailyTasks(host: HTMLElement) {
  createRoot(host).render(<DailyTasksPage />);
}
