export type JobType = 'liked' | 'playlist'

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed'

export interface JobConfig {
  type: JobType
  token: string
  refresh?: string
  playlistId?: string
  playlistName?: string
}

export interface JobProgress {
  current: number
  total: number
  percentage: number
  message: string
}

export interface JobResult {
  success: boolean
  tracksChanged?: number
  message: string
  error?: any
}

export interface Job {
  id: string
  type: JobType
  status: JobStatus
  config: JobConfig
  progress: JobProgress
  result?: JobResult
  startTime?: number
  endTime?: number
  createdAt: number
}

export interface WSMessage {
  type: 'progress' | 'complete' | 'error' | 'status'
  jobId: string
  data: JobProgress | JobResult | { status: JobStatus; progress?: JobProgress }
}
