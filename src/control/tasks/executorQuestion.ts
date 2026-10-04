/** A finished executor turn can hand a blocking question back to the inbox. */
export function executorQuestion(text: string): { question: string; options: string[] | null; result: string | null } | null {
    const marker = /(?:^|\n)```ask_user\s*\n([\s\S]*?)\n```\s*$/.exec(text);
    if (marker) {
        try {
            const value = JSON.parse(marker[1]!) as { question?: unknown; options?: unknown };
            const question = typeof value.question === "string" ? value.question.trim() : "";
            if (!question || [...question].length > 300) return null;
            const options = Array.isArray(value.options) && value.options.length >= 2 && value.options.length <= 5
                && value.options.every((option: unknown) => typeof option === "string" && !!option.trim() && [...option].length <= 30)
                ? [...new Set((value.options as string[]).map(option => option.trim()))] : null;
            return { question, options: options && options.length >= 2 ? options : null, result: text.slice(0, marker.index).trim() || null };
        } catch { return null; }
    }
    // Older executors sometimes finish with only a request for a missing slot.
    // Keep this narrow: a completed answer may end with an optional question.
    const plain = text.trim();
    if ([...plain].length > 180 || /\n|https?:\/\/|\]\(/.test(plain)) return null;
    if (!/^(?:你想看|你要查|请告诉我|请提供|麻烦告诉我|发(?:我)?(?:个)?|需要你(?:提供|确认))/.test(plain)) return null;
    if (!/(?:哪个城市|哪座城市|城市名|邮编|出发地|目的地|哪天|日期|具体地址|预算|哪一个)/.test(plain)) return null;
    if (!/[？?]/.test(plain)) return null;
    return { question: plain, options: null, result: null };
}
