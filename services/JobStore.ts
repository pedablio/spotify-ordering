import type { Job, JobType, JobConfig, JobProgress, JobResult, JobStatus } from '../types/jobs'

class JobStore {
  private jobs: Map<string, Job> = new Map()
  private readonly MAX_JOBS = 100
  private readonly CLEANUP_THRESHOLD = 24 * 60 * 60 * 1000 // 24 hours

  generateJobId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`
  }

  createJob(type: JobType, config: JobConfig): Job {
    const jobId = this.generateJobId()
    const job: Job = {
      id: jobId,
      type,
      status: 'pending',
      config,
      progress: {
        current: 0,
        total: 0,
        percentage: 0,
        message: 'Iniciando...',
      },
      createdAt: Date.now(),
    }

    this.jobs.set(jobId, job)
    this.cleanup()
    return job
  }

  getJob(jobId: string): Job | undefined {
    return this.jobs.get(jobId)
  }

  updateStatus(jobId: string, status: JobStatus): void {
    const job = this.jobs.get(jobId)
    if (!job) return

    job.status = status
    if (status === 'running') {
      job.startTime = Date.now()
    } else if (status === 'completed' || status === 'failed') {
      job.endTime = Date.now()
    }
  }

  updateProgress(jobId: string, progress: JobProgress): void {
    const job = this.jobs.get(jobId)
    if (!job) return
    job.progress = progress
  }

  setResult(jobId: string, result: JobResult): void {
    const job = this.jobs.get(jobId)
    if (!job) return
    job.result = result
  }

  private cleanup(): void {
    if (this.jobs.size <= this.MAX_JOBS) return

    const now = Date.now()
    const jobsArray = Array.from(this.jobs.entries())

    const oldJobs = jobsArray
      .filter(
        ([_, job]) =>
          (job.status === 'completed' || job.status === 'failed') && now - job.createdAt > this.CLEANUP_THRESHOLD,
      )
      .sort((a, b) => a[1].createdAt - b[1].createdAt)

    const toRemove = Math.ceil(oldJobs.length * 0.2)
    for (let i = 0; i < toRemove; i++) {
      this.jobs.delete(oldJobs[i][0])
    }
  }

  getActiveJobs(): Job[] {
    return Array.from(this.jobs.values()).filter(job => job.status === 'pending' || job.status === 'running')
  }
}

export const jobStore = new JobStore()
