import { useDebugMode } from "../debugMode";

/** Owner-only debug switch (this browser only): shows the dispatch log of each message in the main session. */
export function DebugSettings() {
  const [on, setOn] = useDebugMode();
  return (
    <section className="settings-card debug-settings" aria-label="调试模式">
      <div className="settings-section-head">
        <h3>调试模式</h3>
        <p>打开后，主会话里每条消息下方多一个“派单日志”按钮，可以看到这条消息是怎样分配的：主会话时间线、候选任务、Jev 的判断、派单器每一轮的提示词和回答、最终计划。只在当前浏览器生效。</p>
      </div>
      <label className="debug-toggle">
        <input type="checkbox" checked={on} onChange={(event) => setOn(event.target.checked)} />
        <span>{on ? "已开启" : "已关闭"}</span>
      </label>
    </section>
  );
}
