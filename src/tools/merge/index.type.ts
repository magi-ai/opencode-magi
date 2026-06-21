export interface EditOutput {
  commitMessage?: string
  commitSha?: string
  filesTouched: string[]
  mode: "EDITED" | "REPLIED"
  responses: {
    action: "ASK" | "DISAGREE" | "FIXED"
    body: string
    commentId: number
  }[]
}
