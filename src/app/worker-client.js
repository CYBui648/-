export class WorkerClient {
  constructor(workerUrl, onStatusChange = () => {}) {
    this.worker = new Worker(workerUrl, { type: "module" });
    this.pending = new Map();
    this.onStatusChange = onStatusChange;

    this.worker.addEventListener("message", (event) => {
      const { requestId, ok, result, error } = event.data || {};
      const task = this.pending.get(requestId);
      if (!task) return;

      this.pending.delete(requestId);
      this.onStatusChange("idle");

      if (ok) task.resolve(result);
      else task.reject(new Error(error || "Worker 任务失败"));
    });

    this.worker.addEventListener("error", (error) => {
      this.onStatusChange("error");
      for (const task of this.pending.values()) {
        task.reject(error);
      }
      this.pending.clear();
    });
  }

  run(type, payload) {
    const requestId = crypto.randomUUID();
    this.onStatusChange("busy");

    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.worker.postMessage({ requestId, type, payload });
    });
  }
}
