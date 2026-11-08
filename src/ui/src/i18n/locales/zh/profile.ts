/** The person's profile: its page in settings, and the step a new account starts with. */
export const profile = {
  title: "个人资料",
  intro: "都可以不填。助理需要时会在你的知识库里查这些资料，不会每次都带上；clawpage 只能看到你的昵称。",
  fields: {
    nickname: { label: "昵称", placeholder: "例如：小林", hint: "登录 clawpage 时页面看到的名字" },
    preferredName: { label: "希望怎么称呼你", placeholder: "例如：林老师" },
    location: { label: "所在地或时区", placeholder: (zone: string) => `例如：${zone}` },
    language: { label: "常用语言", placeholder: "例如：中文、English" },
    occupation: { label: "职业或身份", placeholder: "例如：产品经理、学生" },
    interests: { label: "兴趣", placeholder: "例如：摄影、徒步、做饭" },
    notes: { label: "想让助理注意的事", placeholder: "例如：回答简短一些；买东西先比价；不要推荐酒类" },
  },
  save: "保存",
  saving: "正在保存…",
  saved: "已保存",
  failed: "没能保存，请重试。",
  loadFailed: "没能读取资料，请重试。",
  retry: "重试",
  /** A new account's first page: four questions; where and in which language come from the browser, unasked. */
  onboarding: {
    step: "最后一步",
    title: "介绍一下你自己",
    body: "四项都可以不填。写上几句，助理就知道怎么称呼你、该留意什么；之后随时可以在「配置 → 个人资料」修改。",
    /** One name for both: what the assistant calls the person, and the nickname a clawpage sees. */
    name: { label: "怎么称呼你", placeholder: "例如：小林", hint: "助理会这样称呼你；登录 clawpage 页面时，页面看到的也是这个名字" },
    done: "完成",
    skip: "跳过",
  },
};
