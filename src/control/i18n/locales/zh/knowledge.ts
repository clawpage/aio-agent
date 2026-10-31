/** Shared knowledge bases (docs/SHARED-KB.md): what people see when something is refused, and the rule presets. */
export const knowledge = {
  notFound: "没有这个共享库，或你不是它的成员",
  adminOnly: "只有管理员能这样做",
  badName: (max: number) => `名称不能为空，最多 ${max} 个字`,
  rulesTooLong: (max: number) => `规则最多 ${max} 个字`,
  sensitive: "内容里像是有密码、验证码、证件号或卡号，不能记进知识库",
  inviteInvalid: "邀请链接无效、已过期或已作废",
  transferFirst: "你是管理员，退出前请先把管理员转给其他成员",
  cannotRemoveSelf: "不能移出自己；要离开请用「退出」",
  notMember: "对方不是这个库的成员",
  required: "内容不能为空",
  tooLong: (max: number) => `最多 ${max} 个字`,
  badDomain: "没有这个领域",
  needContent: "至少写一条内容或一句摘要",
  undoConflict: (n: number) => `有 ${n} 处在这次改动之后又被改过，请先撤销更晚的改动`,
  presets: {
    family: "收：家庭成员的情况和偏好（饮食、过敏、作息、衣服尺码等）、健康与就医安排、孩子的学校和活动、家里的日程与约定、常用的店和服务（家政、维修、医生）、家里设备和账号的用法（不含密码）、全家一起做过的决定。\n不收：只和某一个人有关、别的家人用不上的事；工作；一次性的小事；任何密码、验证码、证件号和卡号。",
    project: "收：项目的目标与范围、做过的决定和理由、约定（命名、流程、分工）、关键做法和踩过的坑、相关的人和系统、重要的链接。\n不收：闲聊；只在一个任务里用得上的临时细节；个人隐私；任何密钥、密码和令牌。",
    blank: "",
  },
};
