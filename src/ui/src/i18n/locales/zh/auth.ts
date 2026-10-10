export const auth = {
  sessionExpired: "登录已过期，请重新登录。",
  restoring: "正在恢复登录…",
  brand: "一站",
  intro: {
    login: "什么事情都在这里一站解决吧。用你的账号登录。",
    register: "什么事情都在这里一站解决吧。用邀请码注册一个账号。",
  },
  fields: {
    username: "账号",
    usernameHint: "2–40 位小写字母、数字、- 或 _",
    password: "密码",
    passwordHint: "请输入访问密码",
    newPasswordHint: "至少 12 个字符",
    confirm: "确认密码",
    confirmHint: "再输入一次密码",
    inviteCode: "邀请码",
  },
  passwordMismatch: "两次输入的密码不一样",
  invite: {
    /** Split around the mailto link. */
    askBefore: "还没有邀请码？发邮件到 ",
    askAfter: " 申请。每个邀请码只能注册一个账号。",
    mailSubject: "申请一站邀请码",
    askAdmin: "邀请码向管理员索取，每个邀请码只能注册一个账号。",
  },
  sessionUnverified: "暂时无法验证登录状态，网络恢复后会自动重试。",
  submit: {
    register: "注册并登录",
    registering: "注册中…",
    login: "登录",
    loggingIn: "登录中…",
  },
  switch: {
    haveAccount: "已有账号？",
    noAccount: "还没有账号？",
    toLogin: "去登录",
    toRegister: "用邀请码注册",
  },
  foreign: {
    title: (owner: string) => `这是 ${owner} 的页面`,
    body: (current: string) => `当前登录的是 ${current}。同一浏览器一次只能登录一个账号。`,
    switchTo: (owner: string) => `退出并登录 ${owner}`,
    backHome: "回到我的页面",
  },
};
