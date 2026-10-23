-- Sanctioned operator statement 3 of 3 (Vlad, 2026-10-10; PLAN-0.5.0 item 35).
-- Clear `seed_built` ONCE, after the seed's last apply, so the build driver's one-shot trigger
-- (item 39: one full build 15 minutes after the seed) re-arms. Run in Data Studio on the STAR
-- namespace, in the object named by the star key. It touches the index meta only: no journal,
-- receipt or grant.
DELETE FROM meta WHERE key = 'seed_built';
