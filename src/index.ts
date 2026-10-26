import { Plugin } from "@opencode/plugin"
import { commands } from "@/commands"
import { Magi } from "./magi"
import { tools } from "./tools"

export const plugin = Plugin.define({
  id: "opencode-magi",
  async setup(context): Promise<void> {
    const magi = new Magi(context)

    await context.command.transform((editor) => {
      Object.entries(commands).forEach(([name, command]) => {
        editor.add({
          description: command.description,
          async execute({ delivery, prompt, sessionID }): Promise<void> {
            await context.session.prompt({
              ...prompt,
              delivery,
              sessionID,
              text: command.template.replaceAll(
                "$ARGUMENTS",
                () => prompt.text,
              ),
            })
          },
          name,
        })
      })
    })
    await context.tool.transform((editor) => {
      Object.values(tools).forEach((tool) => {
        Object.values(tool(magi)).forEach((definition) =>
          editor.add(definition),
        )
      })
    })
  },
})

export default plugin
