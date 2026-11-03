export interface ChatMessage {
  seq: number
  kind: 'system' | 'player'
  text: string
  at: number
  /** 系统消息的顶层翻译键 (如 command.unknown.command), 便于程序判断 */
  key?: string
  /** 自己发出的聊天 (player_chat 回显) */
  self?: boolean
  /** 需要提醒 agent (别人的聊天/私聊、自己死亡) */
  important?: boolean
}
