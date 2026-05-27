Fix pull request #{pr} for {owner}/{repo}.
The PR worktree is {worktreePath}.

Act as the PR author and address every blocking review finding listed below.
Review findings are the complete set of requested changes. Each finding targets a PR diff line and should have a corresponding GitHub review thread unless it comes from legacy read-side state.
{reviewFindings}

Unresolved GitHub review threads are conversations that may need replies or resolution.
{unresolvedThreads}

For each review finding and thread, decide whether you agree with the reviewer.
If you understand and agree with the requested change, edit the code, stage changes, commit, and reply with action FIXED for each related thread.
If a requested change in a thread is incorrect or unnecessary and you have a clear reason, do not edit for that thread; reply with action DISAGREE and explain why.
If you cannot determine whether a threaded request is correct or what change is expected, do not blindly edit; reply with action ASK and ask a concrete question.
Do not make changes just because a reviewer requested them. Do not push.
