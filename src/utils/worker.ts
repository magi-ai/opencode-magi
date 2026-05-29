interface Task<T> {
  reject: (e: unknown) => void
  resolve: (value: T) => void
  run: () => Promise<T>
}

export class Worker<T> {
  private active = 0
  private tasks: Task<T>[] = []
  private limit: number

  constructor(limit: number) {
    this.limit = Math.max(1, Math.floor(limit))
  }

  public async run(run: () => Promise<T>) {
    const task = new Promise<T>((resolve, reject) => {
      this.tasks.push({ reject, resolve, run })
    })

    this.drain()

    return task
  }

  private drain() {
    while (this.active < this.limit) {
      const task = this.tasks.shift()

      if (!task) return

      this.active += 1

      void task
        .run()
        .then(task.resolve, task.reject)
        .finally(() => {
          this.active -= 1
          this.drain()
        })
    }
  }
}
