import { useId, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

/**
 * The three flow diagrams of the Agents wiki guide. Hand-drawn SVG on a fixed
 * grid; colors come from `agent-review-guide.css` so both themes follow the
 * app tokens. Labels are short i18n strings sized for the boxes they sit in.
 */

type ArrowColor = "fg" | "t2" | "t3" | "t4" | "ok" | "warn";

const ARROW_COLORS: readonly ArrowColor[] = ["fg", "t2", "t3", "t4", "ok", "warn"];

/** `useId` yields `:r1:`, which is not usable inside `url(#…)`. */
function useMarkerPrefix(): string {
  return `kxag${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
}

function ArrowMarkers({ prefix }: { prefix: string }) {
  return (
    <defs>
      {ARROW_COLORS.map((color) => (
        <marker
          key={color}
          id={`${prefix}-${color}`}
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M0,0 L10,5 L0,10 z" className={`ag-ah-${color}`} />
        </marker>
      ))}
    </defs>
  );
}

function Arrow({
  d,
  color = "fg",
  dashed = false,
  prefix,
}: {
  d: string;
  color?: ArrowColor;
  dashed?: boolean;
  prefix: string;
}) {
  return (
    <path
      d={d}
      className={`ag-ar ag-ar-${color}${dashed ? " ag-ar-dash" : ""}`}
      markerEnd={`url(#${prefix}-${color})`}
    />
  );
}

function Box({
  x,
  y,
  w,
  h,
  tone = "box",
  title,
  lines = [],
  rx = 9,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  tone?: string;
  title: string;
  lines?: string[];
  rx?: number;
}) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={rx} className={`ag-${tone}`} />
      <text x={x + 14} y={y + 27} className="ag-ttl">
        {title}
      </text>
      {lines.map((line, i) => (
        <text key={i} x={x + 14} y={y + 47 + i * 17} className="ag-sub">
          {line}
        </text>
      ))}
    </g>
  );
}

function Figure({
  caption,
  children,
}: {
  caption: string;
  children: ReactNode;
}) {
  return (
    <figure className="m-0 grid gap-2.5">
      <div className="ag-fig">{children}</div>
      <figcaption className="max-w-[75ch] text-sm text-muted-foreground">
        {caption}
      </figcaption>
    </figure>
  );
}

export function IntakeDiagram() {
  const { t } = useTranslation();
  const p = useMarkerPrefix();
  const k = (key: string) => t(`agentReviewGuide.intake.${key}`);
  const checks = ["check1", "check2", "check3", "check4", "check5"];
  return (
    <Figure caption={k("caption")}>
      <svg viewBox="0 0 980 296" role="img" aria-label={k("aria")}>
        <ArrowMarkers prefix={p} />
        <text x="16" y="22" className="ag-hdr">{k("hdrWho")}</text>
        <text x="300" y="22" className="ag-hdr">{k("hdrChecks")}</text>
        <text x="650" y="22" className="ag-hdr">{k("hdrResult")}</text>

        <rect x="16" y="36" width="220" height="60" rx="8" className="ag-t1" />
        <text x="30" y="60" className="ag-ttl">{k("agent")}</text>
        <text x="30" y="80" className="ag-sub">{k("agentSub")}</text>
        <rect x="16" y="136" width="220" height="60" rx="8" className="ag-t4" />
        <text x="30" y="160" className="ag-ttl">{k("human")}</text>
        <text x="30" y="180" className="ag-sub">{k("humanSub")}</text>

        <rect x="300" y="36" width="270" height="200" rx="10" className="ag-box" />
        {checks.map((key, i) => (
          <g key={key}>
            <circle cx="318" cy={72 + i * 32} r="4" className="ag-tick" />
            <text x="330" y={76 + i * 32} className="ag-lbl">{k(key)}</text>
          </g>
        ))}
        <Arrow d="M435 236 V248" color="warn" prefix={p} />
        <rect x="300" y="250" width="270" height="28" rx="6" className="ag-warn" />
        <text x="435" y="268" textAnchor="middle" className="ag-lbl">{k("rejected")}</text>

        <Box x={650} y={96} w={210} h={80} rx={10} tone="t1" title={k("queue")} lines={[k("queueSub1"), k("queueSub2")]} />

        <Arrow d="M236 66 H298" prefix={p} />
        <Arrow d="M236 166 H298" prefix={p} />
        <Arrow d="M570 136 H648" prefix={p} />
        <Arrow d="M860 136 H960" prefix={p} />
        <text x="872" y="127" className="ag-lbl">{k("toT1")}</text>
      </svg>
    </Figure>
  );
}

export function LadderDiagram() {
  const { t } = useTranslation();
  const p = useMarkerPrefix();
  const k = (key: string) => t(`agentReviewGuide.ladder.${key}`);
  const lanes = [
    { y: 20, h: 150, tier: "t1", label: "T1", top: 70 },
    { y: 170, h: 140, tier: "t2", label: "T2", top: 218 },
    { y: 310, h: 140, tier: "t3", label: "T3", top: 358 },
    { y: 450, h: 150, tier: "t4", label: "T4", top: 498 },
  ];
  return (
    <Figure caption={k("caption")}>
      <svg viewBox="0 0 1000 600" role="img" aria-label={k("aria")}>
        <ArrowMarkers prefix={p} />
        {lanes.map((lane, i) => (
          <g key={lane.tier}>
            <rect x="0" y={lane.y} width="1000" height={lane.h} className={i % 2 === 0 ? "ag-lane" : "ag-lane2"} />
            <text x="16" y={lane.top} className={`ag-tierbig ag-f-${lane.tier}`}>{lane.label}</text>
            <text x="16" y={lane.top + 22} className="ag-lbl">{k(`${lane.tier}Name`)}</text>
            <text x="16" y={lane.top + 38} className="ag-sub">{k(`${lane.tier}Sub`)}</text>
          </g>
        ))}

        <Box x={170} y={55} w={150} h={80} title={k("queue")} lines={[k("queueSub1"), k("queueSub2")]} />
        <Box x={360} y={55} w={190} h={80} tone="t1" title={k("peer")} lines={[k("peerSub1"), k("peerSub2")]} />
        <Box x={590} y={55} w={180} h={80} title={k("gate")} lines={[k("gateSub1"), k("gateSub2")]} />
        <Box x={820} y={55} w={150} h={80} tone="ok" title={k("published")} lines={[k("publishedSub1"), k("publishedSub2")]} />
        <Box x={360} y={200} w={190} h={80} tone="t2" title={k("verify")} lines={[k("verifySub1"), k("verifySub2")]} />
        <Box x={360} y={340} w={190} h={80} tone="t3" title={k("conflict")} lines={[k("conflictSub1"), k("conflictSub2")]} />
        <Box x={590} y={340} w={180} h={80} tone="t3" title={k("panel")} lines={[k("panelSub1"), k("panelSub2")]} />
        <Box x={820} y={340} w={150} h={80} tone="warn" title={k("returned")} lines={[k("returnedSub1"), k("returnedSub2")]} />
        <Box x={170} y={475} w={600} h={80} tone="t4" title={k("human")} lines={[k("humanSub1"), k("humanSub2")]} />
        <Box x={820} y={475} w={150} h={80} title={k("rejected")} lines={[k("rejectedSub")]} />

        <Arrow d="M320 95 H358" prefix={p} />
        <Arrow d="M550 95 H588" prefix={p} />
        <Arrow d="M770 95 H818" color="ok" prefix={p} />

        <Arrow d="M260 135 V240 H358" color="t2" prefix={p} />
        <text x="270" y="182" className="ag-lbl">{k("toT2a")}</text>
        <text x="270" y="196" className="ag-lbl">{k("toT2b")}</text>
        <Arrow d="M550 240 H640 V137" color="t2" prefix={p} />
        <text x="648" y="190" className="ag-lbl">{k("flagshipA")}</text>
        <text x="648" y="204" className="ag-lbl">{k("flagshipB")}</text>

        <Arrow d="M200 135 V473" dashed prefix={p} />
        <text x="210" y="296" className="ag-sub">{k("humanAnyA")}</text>
        <text x="210" y="311" className="ag-sub">{k("humanAnyB")}</text>

        <Arrow d="M455 280 V338" color="t3" prefix={p} />
        <text x="465" y="314" className="ag-lbl">{k("disagreement")}</text>
        <Arrow d="M550 380 H588" color="t3" prefix={p} />
        <Arrow d="M740 340 V137" color="ok" prefix={p} />
        <text x="748" y="262" className="ag-lbl">{k("agree")}</text>
        <text x="748" y="276" className="ag-lbl">{k("yes")}</text>
        <Arrow d="M770 365 H818" color="warn" prefix={p} />
        <text x="794" y="343" textAnchor="middle" className="ag-lbl">{k("agree")}</text>
        <text x="794" y="357" textAnchor="middle" className="ag-lbl">{k("no")}</text>

        <Arrow d="M680 420 V473" color="t4" prefix={p} />
        <text x="672" y="446" textAnchor="end" className="ag-lbl">{k("toT4")}</text>

        <Arrow d="M770 490 H800 V405 H818" color="warn" prefix={p} />
        <Arrow d="M770 530 H818" prefix={p} />
        <Arrow d="M720 555 V578 H988 V95 H972" color="ok" prefix={p} />
        <text x="900" y="572" className="ag-lbl">{k("approved")}</text>
      </svg>
    </Figure>
  );
}

function StatePill({
  cx,
  y,
  w,
  tone,
  title,
  sub,
}: {
  cx: number;
  y: number;
  w: number;
  tone: string;
  title: string;
  sub: string;
}) {
  return (
    <g>
      <rect x={cx - w / 2} y={y} width={w} height="50" rx="25" className={`ag-${tone}`} />
      <text x={cx} y={y + 22} textAnchor="middle" className="ag-ttl">{title}</text>
      <text x={cx} y={y + 40} textAnchor="middle" className="ag-sub">{sub}</text>
    </g>
  );
}

export function StatesDiagram() {
  const { t } = useTranslation();
  const p = useMarkerPrefix();
  const k = (key: string) => t(`agentReviewGuide.states.${key}`);
  return (
    <Figure caption={k("caption")}>
      <svg viewBox="0 0 760 290" role="img" aria-label={k("aria")} className="ag-narrow">
        <ArrowMarkers prefix={p} />
        <StatePill cx={80} y={110} w={120} tone="box" title={k("draft")} sub={k("draftSub")} />
        <StatePill cx={310} y={110} w={160} tone="t1" title={k("pending")} sub={k("pendingSub")} />
        <StatePill cx={640} y={30} w={180} tone="ok" title={k("approved")} sub={k("approvedSub")} />
        <StatePill cx={640} y={190} w={180} tone="box" title={k("rejected")} sub={k("rejectedSub")} />
        <StatePill cx={310} y={225} w={160} tone="warn" title={k("returned")} sub={k("returnedSub")} />

        <Arrow d="M140 135 H228" prefix={p} />
        <text x="184" y="127" textAnchor="middle" className="ag-lbl">{k("submit")}</text>
        <Arrow d="M390 124 H470 V55 H548" color="ok" prefix={p} />
        <text x="480" y="98" className="ag-lbl">{k("approveA")}</text>
        <text x="480" y="112" className="ag-lbl">{k("approveB")}</text>
        <Arrow d="M390 146 H470 V215 H548" prefix={p} />
        <text x="480" y="168" className="ag-lbl">{k("rejectA")}</text>
        <text x="480" y="182" className="ag-lbl">{k("rejectB")}</text>
        <Arrow d="M280 160 V223" color="warn" prefix={p} />
        <text x="272" y="186" textAnchor="end" className="ag-lbl">{k("returnA")}</text>
        <text x="272" y="200" textAnchor="end" className="ag-lbl">{k("returnB")}</text>
        <Arrow d="M345 225 V162" prefix={p} />
        <text x="353" y="190" className="ag-lbl">{k("reviseA")}</text>
        <text x="353" y="204" className="ag-lbl">{k("reviseB")}</text>
      </svg>
    </Figure>
  );
}
