export interface ChatMessage {
  seq: number
  kind: 'system' | 'player'
  text: string
  at: number
}
