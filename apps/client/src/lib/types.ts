export type Role = "OWNER" | "ADMIN" | "MEMBER";

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  isPlatformAdmin: boolean;
}

export interface OrgSummary {
  id: string;
  name: string;
  role: Role;
  primaryDomain: string | null;
}

export interface Session {
  accessToken: string;
  expiresIn: number;
  user: SessionUser;
  organizations: OrgSummary[];
  activeOrganizationId: string | null;
}

export interface Verification {
  email?: string;
  challengeId: string | null;
  matchNumber: number | null;
  codeSent: boolean;
}

export type AuthResult = Session | { verificationRequired: true; verification: Verification };

export const needsVerification = (r: AuthResult): r is { verificationRequired: true; verification: Verification } => "verificationRequired" in r;

export interface ChallengeState {
  status: "PENDING" | "APPROVED" | "FAILED" | "EXPIRED";
  purpose: "VERIFY" | "RESET" | null;
  attemptsLeft: number;
  expiresAt: string | null;
}

export interface Meta {
  page?: number;
  limit?: number;
  total?: number;
  [k: string]: unknown;
}

export interface Paged<T, M = Meta> {
  data: T;
  meta: M;
}

export interface Plan {
  id: string;
  name: string;
  maxDailyVolume: number;
  priceMonthlyCents: number;
  maxCampaigns: number | null;
  features: string[];
}

export interface Catalogue {
  plans: Plan[];
  sizing: {
    sendsPerWarmInbox: number;
    warmupStartPerInbox: number;
    inboxPriceCents: number;
    maxInboxesPerDomain: number;
    warmupOptions: number[];
    volumeMin: number;
    volumeMax: number;
    tldPricesCents: Record<string, number>;
    campaignStart: { lo: number; hi: number; rampDays: number };
    fastStart: { days: number; lo: number; hi: number; rampDays: number; available: boolean; inboxPriceCents: number | null };
  };
}

export type SubscriptionStatus = "INCOMPLETE" | "INCOMPLETE_EXPIRED" | "TRIALING" | "ACTIVE" | "PAST_DUE" | "UNPAID" | "CANCELED";

export interface SubscriptionView {
  id: string;
  status: SubscriptionStatus;
  planId: string;
  planName: string;
  priceMonthlyCents: number;
  maxDailyVolume: number;
  maxCampaigns: number | null;
  dailyVolume: number;
  inboxQuantity: number;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

export interface Icp {
  industries: string[];
  titles: string[];
  sizes: string[];
  regions: string[];
}

export interface PreviewEmail {
  tab: string;
  day: string;
  subject: string;
  body: string;
}

export interface SendingDomain {
  id: string;
  name: string;
  priceCents: number;
  status: "SELECTED" | "PENDING_REGISTRATION" | "REGISTERING" | "REGISTERED" | "FAILED";
  forwardTo: string | null;
  /** The domain originally picked, when it was taken at purchase time and a close alternative was registered. */
  replacedName?: string | null;
  prewarmed?: boolean;
  dnsVerifiedAt?: string | null;
  lastError?: string | null;
}

export interface Mailbox {
  id: string;
  sendingDomainId: string | null;
  address: string;
  provider: string;
  status: "PLANNED" | "PENDING" | "CREATING" | "CONNECTING" | "WARMING" | "ACTIVE" | "ERROR" | "RELEASED";
  warmupDays: number;
  dailyLimit: number;
  sendCap?: number | null;
  warmupStartedAt?: string | null;
  lastError?: string | null;
  sendingDomain?: { name: string; status: string } | null;
}

export type FactKey = "company" | "sell" | "who" | "where" | "proof";

export interface Fact {
  key: FactKey;
  label: string;
  value: string;
  source: string;
}

export interface BuyerGroup {
  id: string;
  priority: number;
  name: string;
  description: string;
  why: string;
  goals: string[];
  pains: string[];
  objections: string[];
  titles: string[];
  includeSimilarTitles: boolean;
  seniorities: string[];
  sizes: string[];
  regions: string[];
  keywords: string[];
  keywordSuggestions: string[];
  revenueRange: { min: number | null; max: number | null };
  technologies: string[];
  signals: { hiringForTitles: string[]; headcountGrowthPctMin: number | null; recentlyFunded: boolean };
  lookalikeDomains: string[];
  excludeDomains: string[];
  on: boolean;
}

export interface Sourced {
  text: string;
  source: string;
}

export interface BrandDetail {
  company_name: string;
  one_liner: string;
  offerings: string[];
  business_model: "B2B" | "B2C" | "both" | null;
  customer_types: string[];
  customer_size_hint: string | null;
  geographies: string[];
  price_level: string | null;
  proof: Sourced[];
  differentiators: Sourced[];
  named_customers: string[];
  buyer_titles_seen: string[];
  competitors: string[];
  language: string;
  brand_voice: string;
  confidence: number;
  evidence: { claim: string; source: string }[];
}

export interface AnalysisSummary {
  promptVersion: string;
  source: "site" | "answers";
  confidence: number;
  lowConfidence: boolean;
  brandDetail: BrandDetail;
  warning: string | null;
  repairsMade: string[];
}

export interface Sender {
  first: string;
  last: string;
}

export interface MarketView {
  available: boolean;
  reason: string | null;
  /** companiesInSample counts organisations inside the people sample, never the market. companies is a real total only when the paid count is on. */
  groups: { id: string; count: number | null; verified: number | null; companiesInSample?: number; companies?: number | null }[];
  people: number | null;
  verified: number | null;
  sample: { size: number; byCountry: [string, number][]; bySize: [string, number][]; bySeniority: [string, number][] };
  prospects: { audienceId?: string; firstName: string; lastInitial: string; title: string | null; company: string | null; country: string | null; hasEmail: boolean }[];
  /** Examples grouped from the people sample, not a market total. */
  companies?: { audienceId: string; name: string; domain: string | null; country: string | null; employees: number | null; description: string | null; people?: number; titles?: string[] }[];
  checkedAt: string;
}

export type KeywordState = "ok" | "none" | "broad";

export interface KeywordCounts {
  available: boolean;
  reason: string | null;
  groupId: string;
  baseline: number | null;
  keywords: { keyword: string; count: number | null; state: KeywordState | null }[];
}

export interface OnboardingRecord {
  id: string;
  domain: string;
  brand: string;
  summary: string | null;
  icp: Icp;
  preview: PreviewEmail[] | null;
  volume: number;
  warmupDays: number;
  inboxesPerDomain: number;
  provider: "google" | "microsoft" | "mixed";
  analyzedAt: string | null;
  analysisError: string | null;
  paidAt: string | null;
  launchedAt: string | null;
  facts: Fact[];
  groups: BuyerGroup[];
  analysis: AnalysisSummary | null;
  senders: Sender[];
  siteReadable: boolean | null;
  fastStart: boolean;
}

export interface OnboardingState {
  onboarding: OnboardingRecord | null;
  domains: SendingDomain[];
  mailboxes: Mailbox[];
  subscription: { status: SubscriptionStatus; planId: string } | null;
  campaign: { id: string; name: string; status: string; smartleadCampaignId: string | null } | null;
  senderName: string | null;
  aiAvailable: boolean;
  analysisStream?: boolean;
  analysisRun?: { id: string; status: "RUNNING" | "DONE" | "FAILED"; lastSeq: number; createdAt: string; error?: string | null } | null;
  sizeOptions: string[];
  scan?: { pagesRead: number; siteTitle: string | null; hasMx: boolean; hasSpf: boolean };
}

export interface DomainIdea {
  name: string;
  prefix: string;
  suffix: string;
  priceCents: number;
  available: boolean | null;
}

export interface Cockpit {
  engine: { on: boolean; state: "running" | "unpaid" | "paused" | "reviewing" | "resting"; todaySent: number; todayTarget: number; dayKey: string; weekday: number; window: string; timezone: string };
  needsYou: {
    pendingWeeks: { batchId: string; weekStart: string; label: string; sendable: number; total: number }[];
    repliesWaiting: number;
    urgentReplies: number;
    latestReplies: {
      id: string;
      fullName: string | null;
      email: string;
      company: string | null;
      replyClass: string | null;
      replyUrgent: boolean;
      lastMessageAt: string | null;
      lastMessageDirection: "INBOUND" | "OUTBOUND" | null;
      lastMessagePreview: string | null;
    }[];
  };
  week: { sent: number; replies: number; found: number; companies: number };
  lastWeek: { sent: number; replies: number; found: number; companies: number };
  heartbeat: { day: string; sent: number; replies: number }[];
  journey: { found: number; written: number; contacted: number; replied: number };
  activity: { type: string; at: string; title: string }[];
  markets: { id: string; name: string; contacted: number; replies: number; replyRate: number }[];
  subscription: { status: SubscriptionStatus; plan: string } | null;
}

export interface NavCounts {
  inboxAwaiting: number;
  leadsPending: number;
  activeCampaigns: number;
  blocklist: number;
  latestReplyAt: string | null;
  systemAlerts: number;
  browserNotifications: boolean;
  autopilotEnabled: boolean;
  subscriptionStatus: SubscriptionStatus | null;
}

export type ContactStatus = "NEW" | "PERSONALIZED" | "QUEUED" | "CONTACTED" | "REPLIED" | "NO_RESPONSE" | "BLOCKLISTED" | "UNSUBSCRIBED" | "BOUNCED" | "REJECTED";

export interface InboxRow {
  id: string;
  fullName: string | null;
  email: string;
  company: string | null;
  title: string | null;
  photoUrl: string | null;
  status: ContactStatus;
  tier: string | null;
  fitScore: number;
  replyClass: string | null;
  replyUrgent: boolean;
  followUpAt: string | null;
  repliedAt: string | null;
  lastMessageAt: string | null;
  lastMessageDirection: "INBOUND" | "OUTBOUND" | null;
  lastMessagePreview: string | null;
  messageCount: number;
  hasInbound: boolean;
  handledAt: string | null;
  hasDraft: boolean;
  needsReply: boolean;
}

export interface InboxCounts {
  all: number;
  needs: number;
  replied: number;
  sent: number;
  urgent: number;
  byClass: Record<string, number>;
}

export interface ThreadMessage {
  id: string;
  direction: "INBOUND" | "OUTBOUND";
  via: string | null;
  subject: string | null;
  body: string;
  intent: string | null;
  createdAt: string;
  attachments: { url: string; name: string }[];
}

export interface Contact {
  id: string;
  email: string;
  fullName: string | null;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  company: string | null;
  website: string | null;
  phone: string | null;
  linkedinUrl: string | null;
  location: string | null;
  industry: string | null;
  status: ContactStatus;
  personalizationStatus: string;
  personalization?: string | null;
  messageSubject?: string | null;
  followup2?: string | null;
  followup3?: string | null;
  campaignId: string | null;
  batchId: string | null;
  source: string;
  photoUrl: string | null;
  seniority: string | null;
  emailStatus: string | null;
  verifyResult: string | null;
  replyClass: string | null;
  replyUrgent: boolean;
  followUpAt: string | null;
  fitScore: number;
  tier: string | null;
  lastContactedAt: string | null;
  repliedAt: string | null;
  createdAt: string;
  aiDraft?: string | null;
  handledAt?: string | null;
  autoReplyStatus?: string;
  neverAuto?: boolean;
  lastEscalationReason?: string | null;
  campaign?: { id: string; name: string } | null;
}

export interface Thread {
  contact: Contact;
  campaign: { id: string; name: string; language: string } | null;
  messages: ThreadMessage[];
  email: { fromCompany: string | null; fromName: string | null; subject: string | null; signature: string; sentAt: string | null };
  autoReply: { sendAfter: string; includeLink: boolean; language: string; mode: string; willSend: boolean } | null;
}

export interface Company {
  domain: string;
  name: string | null;
  website: string | null;
  industry: string | null;
  employees: number | null;
  description: string | null;
  linkedinUrl: string | null;
}

export interface BatchStats {
  total: number;
  excluded: number;
  sendable: number;
  belowFloor: number;
  tierA: number;
  tierB: number;
  avgFit: number | null;
  pushed: number;
  byCampaign: { campaignId: string | null; name: string | null; count: number }[];
}

export interface Batch {
  id: string;
  weekStart: string;
  label: string;
  status: "SOURCING" | "REVIEW" | "APPROVED" | "SENDING" | "DONE";
  targetClean: number;
  sourcedClean: number;
  excludedCount: number;
  approvedCount: number | null;
  approvedAt: string | null;
  stats: BatchStats;
}

export interface Campaign {
  id: string;
  name: string;
  niche: string | null;
  marketBrief: string | null;
  status: "DRAFT" | "ACTIVE" | "PAUSED" | "ARCHIVED";
  language: string;
  smartleadCampaignId: string | null;
  apolloFilters: Record<string, unknown>;
  dailySendCap: number;
  saturatedAt: string | null;
  createdAt: string;
  leadCount: number;
  verifiedCount: number;
  tierACount: number;
  contactedCount: number;
  replyCount: number;
  replyRate: number | null;
  dailyShare: number;
  tierBCount?: number;
}

export interface BlockEntry {
  id: string;
  entryType: "EMAIL" | "DOMAIN";
  value: string;
  reason: string;
  note: string | null;
  contactId: string | null;
  createdAt: string;
}

export type AutoReplyMode = "OFF" | "SHADOW" | "CANARY" | "LIVE";

export interface OrgSettings {
  autopilotEnabled: boolean;
  weeklyBatchMode: boolean;
  autoApproveBatches: boolean;
  defaultDailySendCap: number;
  perMailboxDailyCap: number;
  blocklistNoReplyDays: number;
  timezone: string;
  sendingWindowStart: string;
  sendingWindowEnd: string;
  language: string;
  personalizationEnabled: boolean;
  requireVerifiedEmail: boolean;
  monthlyCreditCap: number;
  dailyCreditCap: number;
  dailySourceTarget: number;
  apolloCycleResetDay: number;
  perCompanyContactCap: number;
  senderName: string | null;
  senderCompany: string | null;
  senderTitle: string | null;
  senderAddress: string | null;
  meetingLink: string | null;
  valueProp: string | null;
  optOutLine: string | null;
  smartleadDefaultCampaignId: string | null;
  smartleadMailboxIds: number[];
  browserNotifications: boolean;
  autoReplyEnabled: boolean;
  autoReplyMode: AutoReplyMode;
  autoReplyKillSwitch: boolean;
  autoReplyMinConfidence: number;
  autoReplyMaxTurns: number;
  autoReplyMaxAutoSends: number;
  autoReplyDailyCap: number;
  autoReplyThreadGapMinutes: number;
  autoReplyWindowStart: number;
  autoReplyWindowEnd: number;
  autoReplyCanaryCampaigns: string[];
  autoReplySoftAck: boolean;
}

export type Provider = "APOLLO" | "SMARTLEAD" | "MILLIONVERIFIER" | "SLACK_WEBHOOK";

export interface CredentialStatus {
  provider: Provider;
  source: "organization" | "platform" | null;
  masked: string | null;
}

export interface SettingsView {
  settings: OrgSettings;
  credentials: CredentialStatus[];
  limits: { planDailyVolume: number; maxDailyLeads: number; creditsPerLead: number; workingDaysPerMonth: number };
  aiAvailable: boolean;
  voidedAutoReplies?: number;
}

export interface AutopilotStatus {
  on: boolean;
  readiness: { key: string; label: string; ok: boolean; optional?: boolean }[];
  ready: boolean;
  sending: { mailboxes: number; perMailbox: number; ceiling: number | null; dailyTarget: number; csvQueued: number };
  sourcing: { dailyTarget: number; pacing: CreditPacing };
}

export interface CreditPacing {
  unlimited: boolean;
  spentCycle: number;
  spentToday: number;
  remainingCycle: number | null;
  allowanceToday: number | null;
}

export interface AutoReplyMetrics {
  mode: AutoReplyMode;
  enabled: boolean;
  killSwitch: boolean;
  sent: { last24h: number; last7d: number };
  queued: number;
  failed7d: number;
  handedOff7d: number;
  meetingsBooked7d: number;
  negativeAfterAutoReply7d: number;
  wouldSendByClass: { key: string | null; count: number }[];
  skipReasons: { key: string | null; count: number }[];
  escalationReasons: { key: string | null; count: number }[];
}

export interface MailboxesView {
  connected: boolean;
  accounts: { id: number; from_email: string; from_name: string | null; warmup: string | null; attached: boolean }[];
  attached: number[];
  planned: Mailbox[];
  defaultCampaignId: string | null;
  accountsError?: string;
}

export interface Member {
  id: string;
  role: Role;
  status: "ACTIVE" | "INVITED";
  email: string | null;
  name: string | null;
  userId: string | null;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface SystemLog {
  id: string;
  organizationId: string | null;
  level: "INFO" | "WARN" | "ERROR" | "CRITICAL";
  source: string;
  message: string;
  meta: unknown;
  resolvedAt: string | null;
  createdAt: string;
}

export interface Payment {
  id: string;
  organizationId: string;
  stripePaymentIntentId: string;
  stripeInvoiceId: string | null;
  amountCents: number;
  amountRefundedCents: number;
  currency: string;
  status: "REQUIRES_PAYMENT" | "PROCESSING" | "SUCCEEDED" | "FAILED" | "REFUNDED" | "PARTIALLY_REFUNDED";
  failureMessage: string | null;
  description: string | null;
  createdAt: string;
  refunds?: { id: string; amountCents: number; status: string; reason: string | null; createdAt: string }[];
  organization?: { id: string; name: string };
}

export interface Invoice {
  id: string;
  stripeInvoiceId: string;
  number: string | null;
  status: string;
  amountDueCents: number;
  amountPaidCents: number;
  currency: string;
  hostedInvoiceUrl: string | null;
  pdfUrl: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  createdAt: string;
}

export interface InfraProblem {
  kind: "domain" | "mailbox";
  id: string;
  orgId: string;
  orgName: string;
  name: string;
  status: string;
  error: string | null;
  attempts: number;
  updatedAt: string;
}

export interface InfraOverview {
  configured: boolean;
  sslForwarding: boolean;
  dedicatedIpFromVolume: number;
  missingContact: string[];
  balance: { availableCents: number; autoTopup: boolean } | null;
  balanceError: string | null;
  workspaces: number;
  dedicatedIps: number;
  domains: Record<string, number>;
  mailboxes: Record<string, number>;
  held: { orgId: string; orgName: string; reason: string; since: string | null }[];
  problems: InfraProblem[];
}
