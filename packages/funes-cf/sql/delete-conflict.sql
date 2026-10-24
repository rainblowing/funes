-- Sanctioned operator statement 2 of 3 (record 24 §4).
-- Delete one `conflict` journal row once you have read it (its writes, proposal id and created_at)
-- and repaired canon. Replace JOURNAL_ID with the row's id; unedited, the statement fails. It removes
-- only a conflict row: a pending or abandoned journal is untouched.
DELETE FROM apply_journal WHERE id = JOURNAL_ID AND state = 'conflict';
