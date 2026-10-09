import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  formatModelName,
  groupAgentsByReviewLevel,
  type ReviewLevel,
  type RosterAgent,
} from "@/lib/agentRoles";
import { activeLangCode } from "@/lib/useDrugName";
import {
  IntakeDiagram,
  LadderDiagram,
  StatesDiagram,
} from "./AgentReviewDiagrams";
import "@/styles/agent-review-guide.css";

/**
 * Built-in wiki block `{{kinetix:agents}}`: how a proposal moves through the
 * review queue and levels T1–T4, with the models that fill each level read
 * live from `GET /api/agents`. The text lives here (in both locales) rather
 * than in the page's stored HTML so it changes together with the workflow it
 * describes; see docs/superpowers/specs/2026-08-24-tiered-agent-cost-architecture.md.
 */

type Roster =
  | { state: "loading" }
  | { state: "error" }
  | { state: "ready"; groups: Record<ReviewLevel, RosterAgent[]> };

function useAgentRoster(): Roster {
  const [roster, setRoster] = useState<Roster>({ state: "loading" });
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/agents");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { agents?: RosterAgent[] };
        if (!cancelled) {
          setRoster({
            state: "ready",
            groups: groupAgentsByReviewLevel(data.agents ?? []),
          });
        }
      } catch {
        if (!cancelled) setRoster({ state: "error" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return roster;
}

const TIER_KEYS: Record<ReviewLevel, string> = {
  T1: "tierMid",
  T2: "tierFlagship",
  T3: "tierAdjudicator",
};

function ModelsCell({ level, roster }: { level: ReviewLevel; roster: Roster }) {
  const { t, i18n } = useTranslation();
  const k = (key: string) => t(`agentReviewGuide.levels.${key}`);
  const lang = activeLangCode(i18n.language);
  const tier = <div className="font-medium">{k(TIER_KEYS[level])}</div>;

  if (roster.state !== "ready") {
    return (
      <>
        {tier}
        <div className="text-muted-foreground">
          {k(roster.state === "loading" ? "loading" : "error")}
        </div>
      </>
    );
  }
  const agents = roster.groups[level];
  return (
    <>
      {tier}
      {agents.length === 0 ? (
        <div className="text-muted-foreground">{k("none")}</div>
      ) : (
        <ul className="m-0 mt-1 grid list-none gap-1 p-0">
          {agents.map((agent) => (
            <li key={agent.id}>
              <span>
                {agent.recentModel
                  ? formatModelName(agent.recentModel)
                  : k("notReported")}
              </span>
              <span className="text-muted-foreground">
                {" · "}
                {lang === "en" && agent.nameEn ? agent.nameEn : agent.name}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function Section({
  heading,
  children,
}: {
  heading: string;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-4">
      <h2 className="m-0 text-xl font-semibold tracking-tight">{heading}</h2>
      {children}
    </section>
  );
}

function Card({ title, body }: { title: string; body: string }) {
  return (
    <div className="grid min-w-0 content-start gap-1.5 rounded-lg border bg-card p-4">
      <b className="text-[15px]">{title}</b>
      <span className="text-sm text-muted-foreground">{body}</span>
    </div>
  );
}

const PRINCIPLES = ["role", "signals", "blind", "diversity", "human", "audit"];
const HOLDS = [
  "quorum",
  "dispute",
  "flagship",
  "quote",
  "clinical",
  "returned",
  "unpublished",
  "author",
  "apply",
];
const COMPARE_ROWS = ["approvals", "quote", "duplicates", "panel"];
const LEVEL_ROWS: Array<{ level: ReviewLevel | "T4"; tone: string }> = [
  { level: "T1", tone: "t1" },
  { level: "T2", tone: "t2" },
  { level: "T3", tone: "t3" },
  { level: "T4", tone: "t4" },
];

export default function AgentReviewGuide() {
  const { t } = useTranslation();
  const g = (key: string) => t(`agentReviewGuide.${key}`);
  const roster = useAgentRoster();

  return (
    <div className="kx-agent-guide my-6 grid gap-10">
      <div className="grid gap-3">
        <p className="m-0 max-w-[70ch] text-lg text-muted-foreground">
          {g("lead")}
        </p>
        <div className="flex flex-wrap gap-2">
          {(["t1", "t2", "t3", "t4"] as const).map((tier) => (
            <span
              key={tier}
              className={`ag-c-${tier} rounded-full border border-current px-2.5 py-0.5 font-mono text-xs`}
            >
              {g(`chips.${tier}`)}
            </span>
          ))}
        </div>
      </div>

      <Section heading={g("philosophy.heading")}>
        <p className="m-0 max-w-[68ch]">{g("philosophy.p1")}</p>
        <p className="m-0 max-w-[68ch]">{g("philosophy.p2")}</p>
        <div className="grid gap-3.5 [grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr))]">
          {PRINCIPLES.map((key) => (
            <Card
              key={key}
              title={g(`philosophy.${key}Title`)}
              body={g(`philosophy.${key}Body`)}
            />
          ))}
        </div>
      </Section>

      <Section heading={g("levels.heading")}>
        <div className="overflow-x-auto rounded-lg border bg-card">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                {["colLevel", "colWho", "colModels", "colTask", "colWhen"].map(
                  (col) => (
                    <th key={col} className="px-3.5 py-2.5 font-medium">
                      {g(`levels.${col}`)}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {LEVEL_ROWS.map(({ level, tone }) => {
                const row = level.toLowerCase();
                return (
                  <tr key={level} className="border-b align-top last:border-0">
                    <td className={`ag-c-${tone} px-3.5 py-3 text-xl font-extrabold`}>
                      {level}
                    </td>
                    <td className="px-3.5 py-3">{g(`levels.${row}Who`)}</td>
                    <td className="px-3.5 py-3">
                      {level === "T4" ? (
                        g("levels.t4Models")
                      ) : (
                        <ModelsCell level={level} roster={roster} />
                      )}
                    </td>
                    <td className="px-3.5 py-3">{g(`levels.${row}Task`)}</td>
                    <td className="px-3.5 py-3">{g(`levels.${row}When`)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="m-0 max-w-[75ch] text-sm text-muted-foreground">
          {g("levels.note")}
        </p>
      </Section>

      <Section heading={g("intake.heading")}>
        <IntakeDiagram />
      </Section>

      <Section heading={g("ladder.heading")}>
        <p className="m-0 max-w-[68ch]">{g("ladder.intro")}</p>
        <LadderDiagram />
      </Section>

      <Section heading={g("states.heading")}>
        <StatesDiagram />
      </Section>

      <Section heading={g("compare.heading")}>
        <p className="m-0 max-w-[68ch]">{g("compare.intro")}</p>
        <div className="overflow-x-auto rounded-lg border bg-card">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-3.5 py-2.5" />
                <th className="px-3.5 py-2.5 font-medium">{g("compare.colText")}</th>
                <th className="px-3.5 py-2.5 font-medium">{g("compare.colValue")}</th>
              </tr>
            </thead>
            <tbody>
              {COMPARE_ROWS.map((row) => (
                <tr key={row} className="border-b align-top last:border-0">
                  <td className="w-[22%] px-3.5 py-3 font-semibold">
                    {g(`compare.${row}`)}
                  </td>
                  <td className="px-3.5 py-3">{g(`compare.${row}Text`)}</td>
                  <td className="px-3.5 py-3">{g(`compare.${row}Value`)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section heading={g("holds.heading")}>
        <p className="m-0 max-w-[68ch]">{g("holds.intro")}</p>
        <ul className="m-0 grid list-none gap-x-7 p-0 [grid-template-columns:repeat(auto-fit,minmax(min(100%,250px),1fr))]">
          {HOLDS.map((key) => (
            <li key={key} className="grid min-w-0 gap-0.5 border-b border-dashed py-2.5">
              <b className="text-[15px]">{g(`holds.${key}Title`)}</b>
              <span className="text-sm text-muted-foreground">
                {g(`holds.${key}Body`)}
              </span>
            </li>
          ))}
        </ul>
      </Section>

      <Section heading={g("after.heading")}>
        <div className="grid gap-3.5 [grid-template-columns:repeat(auto-fit,minmax(min(100%,230px),1fr))]">
          {["store", "audit", "level"].map((key) => (
            <Card
              key={key}
              title={g(`after.${key}Title`)}
              body={g(`after.${key}Body`)}
            />
          ))}
        </div>
      </Section>
    </div>
  );
}
