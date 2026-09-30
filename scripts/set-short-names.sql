-- Short names for drugs in the Kinetix database
-- Run in Neon dashboard after applying migration 0004

-- Abbreviations and common short names
UPDATE drugs SET name_short = '3-CMC' WHERE name = '3-klormetkatinon';
UPDATE drugs SET name_short = '6-MAM' WHERE name = '6-monoacetylmorfin';
UPDATE drugs SET name_short = 'BHB' WHERE name = 'Betahydroksybutyrat';
UPDATE drugs SET name_short = 'GHB' WHERE name = 'Gammahydroksybutyrat';
UPDATE drugs SET name_short = 'HHC' WHERE name = 'Heksahydrocannabinol';
UPDATE drugs SET name_short = 'DMT' WHERE name = 'Dimetyltryptamin (DMT)';
UPDATE drugs SET name_short = 'CBD' WHERE name = 'Cannabidiol';
UPDATE drugs SET name_short = 'Δ8-THC' WHERE name = 'Delta-8-Tetrahydrocannabinol';
UPDATE drugs SET name_short = 'PCP' WHERE name = 'Fensyklidin';
UPDATE drugs SET name_short = 'MDMA' WHERE name = 'MDMA (ecstasy)';
UPDATE drugs SET name_short = 'MHD' WHERE name = '10-OH-karbazepin (MHD)';
UPDATE drugs SET name_short = '7-AF' WHERE name = '7-aminoflunitrazepam';
UPDATE drugs SET name_short = '7-AK' WHERE name = '7-aminoklonazepam';
UPDATE drugs SET name_short = '7-AN' WHERE name = '7-aminonitrazepam';
UPDATE drugs SET name_short = '9-OH-Risp' WHERE name = '9-OH-risperidon';
UPDATE drugs SET name_short = 'ODSMT' WHERE name = 'O-desmetyltramadol';
UPDATE drugs SET name_short = 'OH-Bupropion' WHERE name = 'Hydroksybupropion';
UPDATE drugs SET name_short = 'Nordiazepam' WHERE name = 'N-desmetyldiazepam';
UPDATE drugs SET name_short = 'ASA' WHERE name = 'Salisylsyre';
UPDATE drugs SET name_short = 'N-Pyr-Meton' WHERE name = 'N-pyrrolidinmetonitazen';
UPDATE drugs SET name_short = 'N-Pyr-Proton' WHERE name = 'N-pyrrolidinprotonitazen';
UPDATE drugs SET name_short = 'Deksklor' WHERE name = 'Deksklorfeniramin';
UPDATE drugs SET name_short = 'Klorprotix' WHERE name = 'Klorprotixen';
UPDATE drugs SET name_short = 'Levomepro' WHERE name = 'Levomepromazin';
UPDATE drugs SET name_short = 'Proklorper' WHERE name = 'Proklorperazin';
UPDATE drugs SET name_short = 'Zuklopentix' WHERE name = 'Zuklopentixol';
UPDATE drugs SET name_short = 'Metamfet' WHERE name = 'Metamfetamin';
UPDATE drugs SET name_short = 'Deksamfet' WHERE name = 'Deksamfetamin';
UPDATE drugs SET name_short = 'Levoamfet' WHERE name = 'Levoamfetamine';
UPDATE drugs SET name_short = 'Metylfenidat' WHERE name = 'Metylfenidat';
UPDATE drugs SET name_short = 'Desalkylgida' WHERE name = 'Desalkylgidazepam';
UPDATE drugs SET name_short = 'Psilocin-Gluc' WHERE name = 'Psilocinglukuronid';
