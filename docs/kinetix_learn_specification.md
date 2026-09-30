# Kinetix Learn: Source-Based Adaptive Curriculum for Clinical Pharmacology

## 1. Purpose

**Kinetix Learn** is a proposed learning module inside Kinetix. It turns Kinetix from a clinical pharmacology reference system into an integrated specialist-training portal for clinical pharmacology.

The module is designed primarily for **LIS physicians in clinical pharmacology**, but it should also be useful for board-level specialists and senior clinical pharmacologists who want to repeat foundational material, discover new research, or revisit areas that were not emphasised in their original training.

The central product idea is simple:

> Each lesson is built around one digestible scientific source or source excerpt, with guided pre-reading, prerequisite mapping, Kinetix cross-links, and post-reading assessment that tests both factual understanding and critical reasoning.

The system should teach users not only pharmacological facts, but also how to read, understand, critique, and clinically contextualise the scientific literature of clinical pharmacology.

## 2. Target learners

The default learner is a physician in specialty training in clinical pharmacology. The curriculum should assume basic medical knowledge, basic physiology, basic biochemistry, basic statistics, and general familiarity with drug therapy.

However, adjacent-field knowledge should not be assumed when it becomes sufficiently advanced to block understanding. For example, a LIS physician may know what clearance is, but may not know nonlinear mixed-effects modelling, target trial emulation, or regulatory-grade exposure-response modelling. These should be identified as prerequisites when relevant.

The system should support several user levels:

- Medical or pharmacy student with pharmacology interest
- LIS physician in clinical pharmacology
- Board-level clinical pharmacologist
- Senior clinical pharmacologist using the system for repetition or updates
- Research-level expert track user

The long-term end state should be a path capable of taking a motivated user toward **research-level expertise**, although the first production-quality build should focus on foundational and intermediate LIS-level material before advanced topics are heavily populated.

## 3. Scope

Kinetix Learn should eventually cover the whole field of clinical pharmacology. The broad order should be:

1. Orientation to scientific reading and clinical pharmacology reasoning
2. Core pharmacology concepts
3. Pharmacokinetics
4. Pharmacodynamics
5. PK/PD integration and therapeutic drug monitoring
6. Pharmacogenomics
7. Adverse drug reactions and pharmacovigilance
8. Drug interactions
9. Clinical toxicology
10. Clinical trial interpretation
11. Evidence synthesis and guideline reasoning
12. Regulatory pharmacology and drug development
13. Advanced pharmacometrics, precision dosing, and research-frontier topics

The curriculum should balance current clinical consensus, historically important foundational sources, mechanistic depth, regulatory reasoning, and critical appraisal.

## 4. Relationship to the wider Kinetix app

Kinetix is primarily a pharmacology reference for use in clinical settings by specialists. Kinetix Learn extends it into an all-in-one portal for pharmacology education and specialty training.

The module should be accessible from the Kinetix header menu as a distinct learning area.

It should cross-link with the rest of Kinetix wherever useful. If a learning unit mentions a drug, drug class, target, enzyme, transporter, adverse reaction, pharmacokinetic concept, pharmacodynamic concept, statistical method, guideline, or regulatory concept that exists elsewhere in Kinetix, that term should be clickable.

Examples:

- A lesson on CYP2D6 pharmacogenomics should link to CYP2D6, relevant drug monographs, phenotype definitions, and pharmacogenomic interpretation pages.
- A lesson on lithium TDM should link to the lithium monograph, renal elimination, therapeutic index, sampling time, toxicity, and monitoring pages.
- A lesson on serotonin syndrome should link to serotonergic drugs, pharmacodynamic interactions, diagnostic criteria, and toxicology pages.
- A lesson on bioequivalence should link to AUC, Cmax, confidence intervals, regulatory standards, and generic substitution concepts.

The learning module should not duplicate Kinetix monographs unnecessarily. It should teach users how to use and understand the reference material in context.

## 5. Main user-facing areas

Kinetix Learn should have four main entry points.

### 5.1 My Path

The adaptive recommendation view. It suggests what the user should study next based on demonstrated knowledge, preferred topics, previous performance, retention needs, and curriculum goals.

The default path should balance factual knowledge, critical appraisal, and statistical reasoning, while allowing the user to tilt the system toward personal preferences.

### 5.2 Topic Map

A free-navigation knowledge map. Users should be able to jump into any topic at any time.

No topic should be hard-locked. Advanced topics should remain accessible, but the system should show clear prerequisite warnings when a user is likely to struggle.

Example warning:

> This lesson assumes understanding of clearance, half-life, AUC, interindividual variability, nonlinear mixed-effects modelling, and covariate analysis. You may continue, but the following prerequisite pages are recommended first.

### 5.3 Source Library

A curated archive of all sources that have been evaluated and converted into learning units.

Allowed source types include:

- Original research papers
- Landmark historical papers
- Systematic reviews
- Clinical guidelines
- Regulatory assessment reports
- Drug labels and product information
- Consensus statements
- Textbook excerpts
- Pharmacovigilance reports
- Methodological papers
- High-quality educational sources

Long sources may be used as selected excerpts when the full source is too large for one learning unit.

### 5.4 Cases & Review

A review and applied-reasoning area. Users can revisit concepts, answer spaced review questions, and work through realistic educational clinical cases.

Clinical cases should carry a small notice:

> Educational case only — not patient-specific clinical advice.

## 6. Core pedagogical principles

The system should be governed by these principles:

1. **Source-centred learning**: every lesson is anchored in a real source or source excerpt.
2. **Digestible units**: each unit must be small enough to be read and understood as one assignment.
3. **Active reading**: the user receives source-specific things to look out for before reading.
4. **Prerequisite transparency**: the user sees what prior concepts the unit depends on.
5. **No hard locks**: users may jump freely, but should receive warnings when prerequisites are missing.
6. **Dual assessment**: questions test both factual comprehension and reasoned critique.
7. **Explanation-rich feedback**: every answer option is explained, including wrong options.
8. **Clinical realism with safety framing**: realistic cases are allowed, but framed as education only.
9. **Kinetix integration**: lessons should link to relevant monographs, wiki pages, and concept pages.
10. **Iterative expansion**: the system should first build excellent foundational and LIS-level content before heavily populating senior and research-level content.

## 7. Anatomy of one learning unit

Each learning unit should have a consistent structure.

### 7.1 Source card

The source card should include:

- Title
- Authors or issuing body
- Year
- Source type
- Journal, organisation, or regulatory body
- DOI, PMID, URL, or other identifier where available
- Topic tags
- Estimated reading time
- Difficulty level
- Why the source matters
- Whether the source is foundational, current-consensus, historical, methodologically instructive, regulatory-important, practice-changing, controversial, or useful for correcting a common misconception

### 7.2 Prerequisites

Prerequisites should be visible before the user starts reading.

Each prerequisite should be labelled as one of:

- Essential
- Helpful
- Advanced-adjacent
- Optional context

The system should also explain why the prerequisite matters.

Example:

> **Clearance — essential**: this paper interprets dose adjustment through changes in systemic clearance. Without understanding clearance, the exposure-response discussion will be difficult to follow.

### 7.3 Pre-reading guide

Before reading, the user should receive 3–8 source-specific prompts.

These should not be generic objectives. They should guide attention to what matters in the specific source.

Examples:

- Pay attention to how exposure is defined: dose, trough concentration, AUC, Cmax, or model-predicted exposure.
- Notice whether the chosen comparator permits the conclusion the authors want to draw.
- Watch how missing concentration samples are handled.
- Look at whether statistical significance is treated as clinical relevance.
- Note whether the authors distinguish association, mechanism, and causality.
- Pay attention to whether subgroup findings are prespecified or exploratory.
- Notice whether the endpoint is clinically meaningful or merely a surrogate.

### 7.4 Reading assignment

The user reads the source or selected excerpt.

The system should preserve the source as the centre of the lesson. The learning unit should not become a generic lecture loosely inspired by the source.

### 7.5 Assessment

After reading, the user should be offered assessment.

Question modes:

- Submit all answers at the end
- Submit each question one by one with immediate feedback

Question types:

- Single-best-answer
- Select-all-that-apply

Question categories:

- Factual questions
- Reasoned questions

Each lesson should have at least 10 questions. Richer sources may justify several tens of questions.

### 7.6 Feedback

For every question, every option should have an explanation.

Correct-option explanations should explain why the answer is right and connect it to the source and underlying concept.

Incorrect-option explanations should explain exactly why the option is wrong, preferably by identifying the misconception.

Example:

> Incorrect. This option confuses bioavailability with absorption. A drug can be completely absorbed from the gut but still have low oral bioavailability because of first-pass metabolism.

## 8. Adaptive model

The system should adapt to the user, but should not constrain them unnecessarily.

It should track separate dimensions of competence:

- Factual knowledge
- Critical appraisal skill
- Statistical reasoning
- Clinical pharmacology reasoning
- Retention over time
- Learner preference

The default adaptation should balance factual knowledge, critical appraisal, and statistical reasoning.

Learner preference should still matter. A user may prefer mechanistic depth, clinical cases, statistics, regulatory sources, historical sources, frontier research, or review mode.

The recommendation engine should present its suggestions as guidance, not as a rigid path.

Example:

> Recommended next: Bioavailability and first-pass metabolism. This is suggested because you struggled with exposure terminology in the last two lessons and because it is a prerequisite for the upcoming oral anticoagulant interaction unit.

## 9. Core Concepts Foundation Block

The consensus concepts from the linked BPS/Wiley source and the International Core Concepts of Pharmacology Education Project should be taught early.

The official Core Concepts project lists **25 Core Concepts of Pharmacology Education**, grouped into pharmacokinetics, pharmacodynamics, and PK–PD intersection concepts. The project describes its method as a staged process using data mining of pharmacology texts, a survey of more than 200 pharmacology educators, and three Delphi rounds by an international expert group.

This means Kinetix Learn should start with a **Core Concepts Foundation Block** immediately after the orientation phase.

The first source-based lesson in this block should be based on the linked consensus paper:

- Source link: https://bpspubs.onlinelibrary.wiley.com/doi/pdf/10.1111%2Fbph.16000
- Role in curriculum: early anchor source
- Working unit title: **Why core concepts matter in pharmacology education**
- Educational purpose: teach why Kinetix Learn is organised around durable pharmacological concepts rather than only drug classes or isolated facts

Exact bibliographic details should be verified from the source during ingestion, because source metadata should not be guessed.

### 9.1 PK core concepts

These should be taught early:

1. Drug absorption
2. Drug distribution
3. Drug metabolism
4. Drug elimination
5. Drug bioavailability
6. Volume of distribution
7. Drug clearance
8. Steady-state concentration
9. Zero- and first-order kinetics
10. Drug half-life

### 9.2 PD core concepts

These should be taught early:

1. Drug efficacy
2. Mechanism of drug action
3. Agonists and antagonists
4. Drug affinity
5. Drug selectivity
6. Drug tolerance
7. Drug target
8. Drug–receptor interaction
9. Structure–activity relationship

### 9.3 PK–PD intersection concepts

These should be taught early:

1. Adverse drug reaction
2. Therapeutic index
3. Dose/concentration–response relationship
4. Drug interaction
5. Drug potency
6. Individual variation in drug response

### 9.4 How the Core Concepts should be used

The Core Concepts should not be treated as a superficial glossary. Each concept should have:

- A short concept page
- At least one source-based learning unit
- Worked clinical examples
- Kinetix cross-links
- Multiple-choice questions
- Links to downstream advanced topics

Every later learning unit should map back to these concepts when relevant.

Example:

> This lesson rests on clearance, half-life, therapeutic index, drug interaction, and individual variation in drug response.

## 10. Revised default learning path

### Phase 0 — How to learn in Kinetix Learn

Purpose: orient the user to source-based learning, prerequisite warnings, active reading, assessment, feedback, and Kinetix cross-linking.

Topics:

- How to read a scientific paper
- Source types in clinical pharmacology
- Difference between mechanism, association, causation, and clinical recommendation
- Difference between factual comprehension and critical appraisal
- How to use Kinetix monographs and wiki pages while studying
- Basic safety framing for educational clinical cases

### Phase 1 — Core Concepts Foundation Block

Purpose: teach the 25 Core Concepts early and use them as anchors for the rest of the curriculum.

Subclusters:

1. Drug exposure and movement: absorption, bioavailability, distribution, volume of distribution, metabolism, elimination, clearance, half-life, steady state, zero- and first-order kinetics.
2. Drug action at targets: drug target, drug–receptor interaction, mechanism of action, agonists and antagonists, affinity, efficacy, potency, selectivity, tolerance, and structure–activity relationship.
3. Exposure–response integration: dose/concentration–response, therapeutic index, adverse drug reaction, drug interaction, and individual variation in drug response.
4. Clinical reasoning synthesis: explaining why two patients receiving the same dose may have different exposure, response, toxicity risk, and monitoring needs.

### Phase 2 — Pharmacokinetics deepening

Topics:

- Compartmental thinking
- Non-compartmental analysis
- Population pharmacokinetics
- Renal impairment
- Hepatic impairment
- Paediatric pharmacokinetics
- Pregnancy and lactation
- Obesity and critical illness
- Bioequivalence
- Pharmacokinetics in overdose
- Sampling time and interpretation

### Phase 3 — Pharmacodynamics deepening

Topics:

- Receptor theory
- Emax and sigmoid Emax models
- Concentration-response relationships
- Dose-response relationships
- Target engagement
- Biomarkers and surrogate endpoints
- Tolerance and tachyphylaxis
- Spare receptors
- Partial agonism and inverse agonism
- Biased agonism where relevant

### Phase 4 — PK/PD integration and therapeutic drug monitoring

Topics:

- Therapeutic ranges
- Trough versus peak sampling
- AUC-guided dosing
- Concentration–toxicity relationships
- Concentration–efficacy relationships
- Bayesian dosing concepts at a conceptual level
- Assay limitations
- Adherence interpretation
- When TDM is useful
- When TDM is misleading

### Phase 5 — Pharmacogenomics

Topics:

- Pharmacogenes
- Alleles, diplotypes, and phenotypes
- Metaboliser categories
- CYP enzymes
- HLA risk alleles
- Transporters
- Pharmacodynamic variants
- Penetrance and ancestry
- Test validity and clinical utility
- Genotype-guided prescribing
- Implementation barriers
- Regulatory labelling

### Phase 6 — Adverse drug reactions and pharmacovigilance

Topics:

- ADR classification
- Dose-related versus idiosyncratic reactions
- Causality assessment
- Seriousness versus severity
- Dechallenge and rechallenge
- Medication errors
- Spontaneous reporting
- Signal detection
- Disproportionality
- Stimulated reporting
- Pharmacoepidemiology
- Risk management plans
- Periodic safety updates
- Benefit-risk reasoning

### Phase 7 — Drug interactions

Topics:

- Pharmacokinetic interactions
- Pharmacodynamic interactions
- CYP inhibition and induction
- Time-dependent inhibition
- Transporter interactions
- Absorption interactions
- Food interactions
- Alcohol interactions
- QT prolongation
- Serotonergic toxicity
- Bleeding risk
- Interaction evidence quality

The curriculum should emphasise the difference between mechanistically plausible, pharmacokinetically demonstrated, clinically significant, and merely database-listed interactions.

### Phase 8 — Clinical toxicology

Topics:

- Toxicokinetics
- Toxicodynamics
- Dose/exposure relationships in overdose
- Delayed toxicity
- Active metabolites
- Antidotes
- Enhanced elimination
- Extracorporeal removal
- Poison-centre data
- Analytical limitations
- Concentration interpretation
- Forensic caveats where relevant

### Phase 9 — Clinical trial interpretation

Topics:

- Randomisation
- Blinding
- Allocation concealment
- Control groups
- Placebo versus active control
- Superiority, noninferiority, and equivalence
- Pragmatic trials
- Adaptive designs
- Multiplicity
- Subgroup analysis
- Missing data
- Estimands
- Endpoints and surrogate markers
- Harms reporting
- External validity

### Phase 10 — Evidence synthesis and guideline reasoning

Topics:

- Systematic reviews
- Meta-analysis
- Heterogeneity
- Publication bias
- Certainty of evidence
- Benefit-risk trade-offs
- Indirectness
- Imprecision
- Clinical practice guidelines
- Conflicting guideline recommendations
- GRADE-style reasoning

### Phase 11 — Regulatory pharmacology and drug development

Topics:

- Preclinical-to-clinical translation
- First-in-human studies
- Dose selection
- Exposure-response in regulatory decisions
- Bioequivalence
- Biosimilars where relevant
- Labelling
- Public assessment reports
- Paediatric development
- Pregnancy and lactation evidence
- Risk management
- Post-authorisation requirements
- Real-world evidence
- Model-informed drug development

### Phase 12 — Expert integration and research frontier

Topics:

- Advanced pharmacometrics
- PBPK
- Population PK/PD
- Quantitative systems pharmacology
- Model-informed precision dosing
- Causal inference in pharmacoepidemiology
- Target trial emulation
- Regulatory-grade benefit-risk assessment
- Safety signal validation
- Deprescribing science
- Frontier pharmacogenomics

At this level, units may increasingly use paired or clustered sources: for example one original study, one critique, one regulatory document, and one later update.

## 11. Build-order rule

The knowledge base should be populated in this order:

1. High-quality units for the 25 Core Concepts
2. Intermediate LIS-level units in PK, PD, TDM, pharmacogenomics, ADRs, DDIs, toxicology, and clinical trial interpretation
3. Board-level and senior-specialist units
4. Research-level expert units

This prevents the system from becoming impressive but hollow. Advanced lessons should be able to point backward to stable prerequisite concept pages and foundational units.

## 12. Single full-cycle agent prompt

The system should use one full-cycle agent instruction prompt rather than many separate specialised agents. One successful agent run should complete one full source-based learning unit.

### Kinetix Learn Unit Builder Agent

You are the single end-to-end content-building agent for Kinetix Learn, an adaptive clinical pharmacology learning module for LIS physicians in clinical pharmacology, board-level specialists, and senior clinical pharmacologists.

Your task is to complete one full source-based learning unit per run.

Each learning unit must be grounded in one digestible scientific source or one digestible excerpt from a larger source. Accepted source types include original research papers, landmark historical papers, systematic reviews, clinical guidelines, regulatory assessment reports, drug labels, consensus statements, textbook excerpts, pharmacovigilance reports, methodological papers, and other high-quality scientific sources.

Long sources may be used only if you identify a self-contained excerpt that preserves enough context to avoid misleading the learner.

You must not invent facts. You must distinguish clearly between source-stated information, reasonable interpretation, and uncertainty. Every educational claim, question, answer, and explanation must be supportable by the source or by clearly identified prerequisite knowledge. When uncertain, flag the uncertainty rather than resolving it by assumption.

Your run cycle has thirteen stages.

#### Stage 1 — Source discovery or source intake

If given a topic but no source, identify a suitable candidate source. Prefer sources that are foundational, clinically important, methodologically instructive, practice-changing, historically important, regulatory-important, or useful for correcting a common misconception.

If given a source, verify its identity and decide whether it is suitable for a learning unit.

Output:

- Citation
- Source type
- Year
- Source status
- Why the source matters
- Likely learner level
- Estimated reading time
- Whether the full source or an excerpt should be used

#### Stage 2 — Suitability and digestibility assessment

Judge whether the source is small enough to be a learning unit. If not, select a coherent excerpt and explain why it is educationally meaningful.

Reject or defer the source if it is too broad, too low quality, inaccessible, redundant, clinically misleading, insufficiently scientific, or unable to support meaningful assessment questions.

#### Stage 3 — Source-type quality appraisal

Appraise the source according to its type.

Consider design, population, comparator, endpoints, statistical approach, bias, confounding, external validity, conflicts of interest, regulatory relevance, and relationship to prior evidence where applicable.

Do not apply the same appraisal template to every source. A pharmacokinetic study, historical receptor theory paper, drug label, regulatory guidance, systematic review, and case series require different appraisal emphases.

#### Stage 4 — Structured extraction

Create a storage-ready extraction containing:

- Main topics
- Background question
- Hypothesis or purpose
- Study design or document type
- Population or biological system
- Drug/exposure/intervention
- Comparator/control if relevant
- Outcomes/endpoints
- PK/PD measures
- Statistical or analytical methods
- Main findings
- Quantitative results where relevant
- Author interpretation
- Strengths
- Weaknesses
- Uncertainty
- Generalisability
- Clinical relevance
- Regulatory relevance
- Relation to earlier or later research

Also extract salient points about method and findings, including any unusual control group choice, endpoint mismatch, outliers, subgroup interpretation, missing data, overinterpretation, or important historical context.

#### Stage 5 — Core concept and prerequisite mapping

Map the unit to prerequisite concepts. Classify each prerequisite as essential, helpful, advanced-adjacent, or optional context.

Always check whether the source depends on any of the 25 Core Concepts of Pharmacology Education:

- Drug absorption
- Drug distribution
- Drug metabolism
- Drug elimination
- Drug bioavailability
- Volume of distribution
- Drug clearance
- Steady-state concentration
- Zero- and first-order kinetics
- Drug half-life
- Drug efficacy
- Mechanism of drug action
- Agonists and antagonists
- Drug affinity
- Drug selectivity
- Drug tolerance
- Drug target
- Drug–receptor interaction
- Structure–activity relationship
- Adverse drug reaction
- Therapeutic index
- Dose/concentration–response relationship
- Drug interaction
- Drug potency
- Individual variation in drug response

For each prerequisite, explain why it matters and whether a LIS physician can usually be expected to know it. If not, suggest a preparatory unit or concept page.

#### Stage 6 — Kinetix cross-linking

Identify all drugs, drug classes, targets, receptors, enzymes, transporters, mechanisms, adverse reactions, clinical syndromes, pharmacokinetic concepts, pharmacodynamic concepts, statistical concepts, regulatory concepts, and methodology concepts that should link to existing Kinetix monographs or wiki pages.

For each link, provide the link label and reason.

Do not force weak links. Flag missing Kinetix pages that should be created.

#### Stage 7 — Learner placement

Assign the unit to one or more curriculum domains:

- Pharmacokinetics
- Pharmacodynamics
- Therapeutic drug monitoring
- Pharmacogenomics
- Adverse drug reactions
- Drug interactions
- Toxicology
- Clinical trial interpretation
- Evidence synthesis
- Pharmacovigilance
- Regulatory pharmacology
- Pharmacometrics
- Model-informed precision dosing
- Expert frontier material

Assign difficulty level:

- Foundational
- Intermediate LIS
- Advanced LIS
- Board-level
- Senior specialist
- Research-level expert

Recommend what the learner should ideally know before starting and what they might study next.

No topic should be hard-locked. Advanced units should remain accessible, but the learner must see clear prerequisite warnings.

#### Stage 8 — Pre-reading guide

Create 3–8 source-specific things to look out for before the learner reads the source.

These must not be generic learning objectives. They should direct attention to the most educationally important features of the source.

Examples:

- Pay attention to how exposure is defined.
- Notice whether the comparator permits the claimed conclusion.
- Watch how the authors handle missing samples.
- Look at whether statistical significance is treated as clinical relevance.
- Notice how this paper anticipates a later drug-class concept.

#### Stage 9 — Learning objectives

Create concise learning objectives, but keep them subordinate to the source.

The lesson should not become a generic lecture. It should teach the learner to read, understand, and critique this particular source.

Each objective should be linked to one or more concepts, including Core Concepts where relevant.

#### Stage 10 — Assessment creation

Create at least 10 questions for every learning unit. Create more when the source contains enough defensible material.

Use both single-best-answer and select-all-that-apply formats.

Separate questions into factual and reasoned categories.

Factual questions should test:

- What was studied
- What method was used
- What was measured
- What the findings were
- What the authors concluded

Reasoned questions should test:

- Interpretation
- Limitations
- Design critique
- Statistical reasoning
- External validity
- Mechanism
- Clinical significance
- Relationship to previous or later knowledge

For every question, include:

- Question stem
- Answer options
- Correct answer
- Explanation for each option
- Difficulty level
- Concepts tested
- Cognitive skill tested
- Source support

Distractors must be plausible and should reflect common misunderstandings.

#### Stage 11 — Feedback design

For each answer option, explain why it is correct or incorrect.

Incorrect-option explanations must be educational, not merely corrective. Correct-option explanations should connect the answer to the source and to the relevant clinical pharmacology concept.

Mark whether the question is suitable for immediate feedback, end-of-lesson scoring, or both.

The user should be able to answer all questions before scoring or submit one question at a time.

#### Stage 12 — Safety and clinical framing

Realistic clinical cases may be used, but every clinical case must carry this notice:

> Educational case only — not patient-specific clinical advice.

Avoid patient-specific prescribing instructions unless they are framed as educational interpretation of a source, guideline, label, or regulatory document.

Flag any content that requires expert clinical review before publication.

#### Stage 13 — Final self-audit

Before marking the learning unit complete, audit it for:

- Unsupported claims
- Ambiguous questions
- Weak distractors
- Multiple correct answers in single-best questions
- Missing explanations
- Overinterpretation of the source
- Poor prerequisite mapping
- Missing Kinetix cross-links
- Unsafe clinical framing
- Mismatch between difficulty level and content

The unit is complete only if it contains:

- Verified source or excerpt
- Structured extraction
- Salient teaching points
- Prerequisite map
- Kinetix cross-links
- Pre-reading guide
- Curriculum placement
- At least 10 questions
- Answer explanations for every option
- Quality-control decision

If the unit fails quality control, output a revision plan rather than pretending it is ready.

## 13. Default source standards

The curriculum may use:

- Original studies
- Systematic reviews
- Clinical guidelines
- Regulatory documents
- Drug labels
- Pharmacovigilance documents
- Consensus statements
- Textbook excerpts
- Landmark historical papers
- High-quality educational sources

The system should prefer sources that are:

- Scientifically credible
- Clinically relevant
- Methodologically instructive
- Digestible
- Linkable to Kinetix concepts
- Capable of supporting meaningful questions

The system should reject or defer sources that are:

- Too broad for one unit
- Too low quality
- Redundant
- Clinically misleading
- Unsupported by accessible text
- Unable to support assessment
- Too advanced before prerequisites exist

## 14. Assessment philosophy

The assessment system should make the learner better at clinical pharmacology reasoning, not merely better at remembering facts.

A strong unit should contain both:

- **Factual comprehension**: what was tested, what method was used, what was found, what the authors concluded.
- **Reasoned critique**: whether the method supports the conclusion, whether the comparator was appropriate, whether the endpoint was clinically meaningful, whether the statistics were suitable, whether the findings generalise, and whether the paper changes practice.

The most important question type is not “what did the paper say?” but:

> What should a clinical pharmacologist believe after reading this source, and what should remain uncertain?

## 15. Update and maintenance model

Learning units should not be static forever.

The system should monitor whether a source has become outdated because of:

- New guidelines
- New regulatory documents
- Major new trials
- New systematic reviews
- Retractions or corrections
- Drug label changes
- Safety communications
- Important new mechanistic findings

A unit update should be classified as:

- No action
- Minor annotation
- Add counter-source
- Revise lesson
- Retire lesson
- Urgent expert review

Historically important sources should not necessarily be removed when outdated. Instead, they can be preserved as historical lessons if clearly labelled.

## 16. What makes this different from ordinary e-learning

Kinetix Learn should not primarily be a collection of videos, summaries, or generic lectures.

Its distinctive value is that it teaches users to become clinical pharmacologists by repeatedly doing the real work of the field:

1. Reading important sources
2. Understanding the underlying concepts
3. Identifying methodological strengths and weaknesses
4. Connecting findings to mechanisms and patient-level variability
5. Relating sources to current clinical and regulatory practice
6. Testing and refining reasoning through high-quality feedback

The product should feel like a guided apprenticeship in clinical pharmacology literature, supported by Kinetix as the integrated reference layer.

## 17. Reference links

- Linked BPS/Wiley source supplied for the Core Concepts anchor: https://bpspubs.onlinelibrary.wiley.com/doi/pdf/10.1111%2Fbph.16000
- Core Concepts of Pharmacology Education — core concepts list: https://coreconceptspharmacology.org/educator-resources/core-concepts-list/
- Core Concepts of Pharmacology Education — methodology: https://coreconceptspharmacology.org/methodology/
- IUPHAR/BPS Guide to Pharmacology: https://www.guidetopharmacology.org/
- PubMed: https://pubmed.ncbi.nlm.nih.gov/
- EMA clinical pharmacology and pharmacokinetics guidelines: https://www.ema.europa.eu/en/human-regulatory-overview/research-development/scientific-guidelines/clinical-pharmacology-pharmacokinetics
- FDA exposure-response guidance: https://www.fda.gov/regulatory-information/search-fda-guidance-documents/exposure-response-relationships-study-design-data-analysis-and-regulatory-applications
- FDA population pharmacokinetics guidance: https://www.fda.gov/regulatory-information/search-fda-guidance-documents/population-pharmacokinetics
- FDA pharmacogenomic biomarkers in drug labeling: https://www.fda.gov/drugs/science-and-research-drugs/table-pharmacogenomic-biomarkers-drug-labeling
- EMA pharmacovigilance overview: https://www.ema.europa.eu/en/human-regulatory-overview/post-authorisation/pharmacovigilance-post-authorisation
- EQUATOR Network: https://www.equator-network.org/
- CONSORT: https://www.equator-network.org/reporting-guidelines/consort/
- STROBE: https://www.strobe-statement.org/
- PRISMA: https://www.prisma-statement.org/
- Cochrane Handbook: https://training.cochrane.org/handbook
- GRADE working group: https://www.gradeworkinggroup.org/
