-- Phase 9 (cont.): the old reimbursable model is unreferenced as of the previous commit. Dropped in
-- a SEPARATE migration from 015 so the column-adding step could be applied and verified while the
-- application still read the old tables — nothing is dropped until nothing reads it.
drop table if exists reimbursement_write_offs;
drop table if exists reimbursement_splits;
drop table if exists reimbursement_claims;
