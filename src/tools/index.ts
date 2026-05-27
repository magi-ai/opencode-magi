import { Tool } from "@/utils"
import { validate } from "./validate"
import { merge } from "./merge"
import { review } from "./review"
import { triage } from "./triage"
import { clear } from "./clear"

export const tools: Record<string, Tool> = {
  validate,
  review,
  merge,
  triage,
  clear,
}
