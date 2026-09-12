# Voting policy

Every `.md` and `.txt` file in this directory is exposed to the connected AI
agent as an MCP resource under `safe-mpc://policy/<filename>`, and is inlined
into the `vote_on_snapshot_proposal`, `vote_on_governor_proposal` and
`review_open_proposals` prompts.

This is where the Safe's operator states how the agent should vote. Without it
the agent judges each proposal on its merits alone, which is rarely what a DAO
delegate wants.

Two files are usually enough:

- `operating-values.md` for the standing position: what the Safe supports, what
  it opposes, and where it abstains.
- `precedent.md` for how the Safe voted before and why, so decisions stay
  consistent across proposals.

Point `KNOWLEDGE_DIR` at a different directory to keep several policies side by
side, one per DAO.
