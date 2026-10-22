// Types for the Devin API v3 organization session endpoints (https://docs.devin.ai/v3-openapi.json).

export type SessionStatus = "new" | "claimed" | "running" | "exit" | "error" | "suspended" | "resuming";

export type SessionStatusDetail =
  | "working"
  | "waiting_for_user"
  | "waiting_for_approval"
  | "finished"
  | "inactivity"
  | "user_request"
  | "usage_limit_exceeded"
  | "out_of_credits"
  | "out_of_quota"
  | "no_quota_allocation"
  | "payment_declined"
  | "org_usage_limit_exceeded"
  | "user_usage_limit_exceeded"
  | "total_session_limit_exceeded"
  | "contract_expired"
  | "error";

export type DevinMode = "normal" | "fast" | "fusion" | "lite" | "ultra" | "swe-2-medium" | "swe-2-high" | "swe-2-max";

export type SessionOrigin =
  | "webapp"
  | "slack"
  | "teams"
  | "api"
  | "linear"
  | "jira"
  | "automation"
  | "cli"
  | "desktop"
  | "code_scan"
  | "other";

export type SessionCategory =
  | "bug_fixing"
  | "ci_cd_and_devops"
  | "code_quality_and_security"
  | "code_review"
  | "code_review_and_analysis"
  | "data_and_automation"
  | "documentation_and_content"
  | "feature_development"
  | "migrations_and_upgrades"
  | "other"
  | "production_investigation"
  | "refactoring_and_optimization"
  | "research_and_exploration"
  | "security"
  | "unit_test_generation";

export interface Session {
  session_id: string;
  url: string;
  status: SessionStatus;
  title?: string | null;
  tags: string[];
  playbook_id?: string | null;
  user_id?: string | null;
  org_id: string | null;
  /** Unix timestamp (seconds). */
  created_at: number;
  /** Unix timestamp (seconds). */
  updated_at: number;
  is_archived?: boolean;
  acus_consumed: number;
  pull_requests: { pr_url: string; pr_state: string | null }[];
  parent_session_id?: string | null;
  child_session_ids?: string[] | null;
  service_user_id?: string | null;
  category?: SessionCategory | null;
  subcategory?: string | null;
  origin?: SessionOrigin | null;
  automation_id?: string | null;
  structured_output?: Record<string, unknown> | null;
  devin_mode?: DevinMode | null;
  status_detail?: SessionStatusDetail | null;
  on_demand_usage?: number | null;
  security_profile?: { selection: "inherit" | "none" | "profile"; profile_id?: string | null } | null;
}

export interface CreateSessionRequest {
  prompt: string;
  title?: string | null;
  tags?: string[] | null;
  max_acu_limit?: number | null;
  playbook_id?: string | null;
  knowledge_ids?: string[] | null;
  secret_ids?: string[] | null;
  session_secrets?: { key: string; value: string; sensitive?: boolean }[] | null;
  repos?: string[] | null;
  attachment_urls?: string[] | null;
  create_as_user_id?: string | null;
  child_playbook_id?: string | null;
  session_links?: string[] | null;
  bypass_approval?: boolean | null;
  security_profile?: { profile_id?: string | null } | null;
  structured_output_schema?: Record<string, unknown> | null;
  structured_output_required?: boolean | null;
  resumable?: boolean;
  platform?: string | null;
  devin_mode?: DevinMode | null;
}

export interface ListSessionsParams {
  after?: string | null;
  /** Page size, 1-200 (default 100). */
  first?: number;
  session_ids?: string[] | null;
  created_after?: number | null;
  created_before?: number | null;
  updated_after?: number | null;
  updated_before?: number | null;
  tags?: string[] | null;
  playbook_id?: string | null;
  origins?: SessionOrigin[] | null;
  schedule_id?: string | null;
  user_ids?: string[] | null;
  service_user_ids?: string[] | null;
  repo_names?: string[] | null;
  category?: SessionCategory | null;
  is_archived?: boolean | null;
  automation_ids?: string[] | null;
  parent_session_id?: string | null;
}

export interface Page<T> {
  items: T[];
  end_cursor?: string | null;
  has_next_page?: boolean;
  total?: number | null;
}

export interface SessionInsights extends Session {
  num_user_messages: number;
  num_devin_messages: number;
  session_size: "xs" | "s" | "m" | "l" | "xl";
  analysis?: SessionInsightsAnalysis | null;
  analysis_status?: "started" | "completed" | "failed" | null;
}

export interface SessionInsightsAnalysis {
  issues?: { id?: string; title?: string; issue: string; impact: string; label: string }[];
  timeline?: { title: string; description: string; color?: string; issue_id?: string | null }[];
  action_items?: {
    type?: "machine_setup" | "repo_config" | "knowledge" | "prompt_improvement" | "external" | "other";
    action_item: string;
    issue_id?: string | null;
  }[];
  suggested_prompt?: {
    original_prompt: string;
    suggested_prompt: string;
    feedback_items?: { summary: string; excerpt: string; details: string; issue_id?: string | null }[];
  } | null;
  note_usage?: {
    good_usages?: NoteUsageItem[];
    bad_usages?: NoteUsageItem[];
  } | null;
  skill_usage?: {
    good_usages?: SkillUsageItem[];
    bad_usages?: SkillUsageItem[];
  } | null;
  classification?: {
    category: string;
    confidence: number;
    tools_and_frameworks?: string[];
    programming_languages?: string[];
  } | null;
}

export interface NoteUsageItem {
  reason: string;
  message: string;
  note_id: string;
}

export interface SkillUsageItem {
  reason: string;
  skill_name: string;
  repo_origin: string;
  skill_rel_path: string;
}

export interface GenerateInsightsResponse {
  session_id: string;
  /** e.g. "already_exists" when insights were generated before. */
  status: string;
}

export interface SessionAttachment {
  attachment_id: string;
  name: string;
  url: string;
  content_type?: string | null;
  source: "devin" | "user";
}

export interface SessionMessage {
  event_id: string;
  source: "devin" | "user";
  message: string;
  created_at: number;
  username?: string | null;
  user_id?: string | null;
  origin?: string | null;
}

export interface ListMessagesParams {
  after?: string | null;
  /** Page size, 1-200 (default 100). */
  first?: number;
}

export interface SendMessageRequest {
  message: string;
  message_as_user_id?: string | null;
  attachment_urls?: string[] | null;
}
