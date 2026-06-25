export interface EditOutput {
  commitMessage?: string
  commitSha?: string
  filesTouched: string[]
  mode: "EDITED" | "REPLIED" | "RESOLVED"
  responses: {
    action: "ASK" | "DISAGREE" | "FIXED"
    body: string
    commentId: number
  }[]
}
