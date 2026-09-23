import Bottleneck from "bottleneck";
import { fetchJson } from "./http.js";
import { getCredential } from "./credentials.js";

const BASE = "https://api.apollo.io";
const limiter = new Bottleneck({ maxConcurrent: 1, minTime: 1200 });

export interface ApolloPerson {
  id?: string;
  first_name?: string;
  last_name?: string;
  name?: string;
  title?: string;
  headline?: string;
  seniority?: string;
  email?: string | null;
  email_status?: string | null;
  linkedin_url?: string;
  photo_url?: string;
  city?: string;
  state?: string;
  country?: string;
  organization?: {
    id?: string;
    name?: string;
    website_url?: string;
    primary_domain?: string;
    industry?: string;
    estimated_num_employees?: number;
    short_description?: string;
    linkedin_url?: string;
    city?: string;
    country?: string;
  };
  organization_name?: string;
}

export interface ApolloApi {
  searchPeople(filters: Record<string, unknown>, page: number, perPage: number): Promise<{ people: ApolloPerson[]; totalEntries: number | null }>;
  bulkEnrich(people: { id?: string; first_name?: string; last_name?: string; domain?: string; organization_name?: string }[]): Promise<ApolloPerson[]>;
}

export class ApolloClient implements ApolloApi {
  constructor(private readonly apiKey: string) {}

  private post<T>(path: string, body: unknown): Promise<T> {
    return limiter.schedule(() => fetchJson<T>(`${BASE}${path}`, { method: "POST", body, headers: { "X-Api-Key": this.apiKey, "Cache-Control": "no-cache" } }));
  }

  async searchPeople(filters: Record<string, unknown>, page: number, perPage: number) {
    const data = await this.post<{ people?: ApolloPerson[]; contacts?: ApolloPerson[]; pagination?: { total_entries?: number } }>(
      "/api/v1/mixed_people/api_search",
      { ...filters, page, per_page: perPage },
    );
    return { people: data.people ?? data.contacts ?? [], totalEntries: data.pagination?.total_entries ?? null };
  }

  async bulkEnrich(details: { id?: string; first_name?: string; last_name?: string; domain?: string; organization_name?: string }[]) {
    if (!details.length) return [];
    const data = await this.post<{ matches?: (ApolloPerson | null)[] }>("/api/v1/people/bulk_match", {
      reveal_personal_emails: false,
      reveal_phone_number: false,
      details: details.slice(0, 10),
    });
    return (data.matches ?? []).filter((m): m is ApolloPerson => !!m);
  }
}

type Factory = (orgId: string) => Promise<ApolloApi | null>;
const defaultFactory: Factory = async (orgId) => {
  const key = await getCredential(orgId, "APOLLO");
  return key ? new ApolloClient(key) : null;
};
let factory: Factory = defaultFactory;

export function apolloFor(orgId: string): Promise<ApolloApi | null> {
  return factory(orgId);
}

export function setApolloFactory(f: Factory | null): void {
  factory = f ?? defaultFactory;
}
