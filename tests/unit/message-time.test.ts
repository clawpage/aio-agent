import { describe, expect, it } from "vitest";
import { messageTime, taskDuration, formatDuration } from "../../src/ui/src/messageTime";
const now = new Date(2026, 8, 27, 14, 30).getTime();
describe("friendly message metadata", () => {
  it("uses local calendar days and distinguishes relative, same-day, yesterday and older messages", () => {
    expect(messageTime(now - 12_000, now)).toBe("刚刚");
    expect(messageTime(now - 180_000, now)).toBe("3 分钟前");
    expect(messageTime(now - 3600_000, now)).toBe("今天 13:30");
    expect(messageTime(new Date(2026, 8, 26, 23, 59).getTime(), now)).toBe("昨天 23:59");
    expect(messageTime(new Date(2026, 8, 25, 12).getTime(), now)).toBe("9月25日 12:00");
    expect(messageTime(new Date(2025, 8, 25, 12).getTime(), now)).toBe("2025年9月25日 12:00");
    expect(messageTime(now + 1000, now)).toBe("今天 14:30");
    expect(messageTime(null, now)).toBeNull();
    expect(messageTime(NaN, now)).toBeNull();
    expect(messageTime(1e20, now)).toBeNull();
  });
  it("measures actual execution, freezes terminal results, and does not invent missing or uncertain timing", () => {
    const task = { status: "running", startedAt: now - 65_000, completedAt: null };
    expect(taskDuration(task, now)).toBe("已处理 1 分 5 秒");
    expect(taskDuration({ ...task, status: "completed", completedAt: now }, now + 100_000)).toBe("处理用时 1 分 5 秒");
    for (const status of ["queued", "waiting", "needs_input", "unknown", "merged"]) expect(taskDuration({ ...task, status }, now)).toBeNull();
    expect(taskDuration({ ...task, startedAt: null }, now)).toBeNull();
    expect(taskDuration({ ...task, status: "interrupted", completedAt: now }, now)).toBe("处理用时 1 分 5 秒");
    expect(formatDuration(3661000)).toBe("1 小时 1 分");
    expect(formatDuration(-3000)).toBe("0 秒");
  });
});
