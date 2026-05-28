import type { Tool } from "@/utils"
import { clear } from "./clear"
import { merge } from "./merge"
import { review } from "./review"
import { triage } from "./triage"
import { validate } from "./validate"

export const tools: { [key: string]: Tool } = {
  clear,
  merge,
  review,
  triage,
  validate,
}
