export const support = {
  requestKind: 'Request type', ask: 'Question or feedback', askInfo: 'Your explanation goes to the administrator.', deleteAccount: 'Delete account',
  settingsIntro: 'Ask the administrator a question or send feedback, read the privacy policy, or request deletion of your account and related data.', signedInAs: (who: string) => `Signed in as ${who}`,
  account: 'Account & privacy', privacy: 'Privacy policy', deletion: 'Request account deletion',
  limitations: 'AI responses may be inaccurate and provide general information only. Clawpage Agent is not a medical device and does not diagnose, treat or prevent medical conditions. Consult a qualified doctor for medical advice, and qualified professionals for legal or investment advice.',
  feedbackTitle: 'What was wrong with this reply?', feedbackInfo: 'The explanation is optional. If you write one, the administrator sees this reply (up to 20,000 characters) and your explanation, to improve answers.', feedbackHint: 'For example: it was wrong, it misunderstood me, it was too long. Do not include passwords or other secrets.', alsoReport: 'Also report this reply (illegal, harmful or inappropriate content)', feedbackThanks: 'Thanks, your feedback is recorded.', feedbackQueue: 'Reply feedback', feedbackQueueInfo: 'People\'s likes and dislikes on AI replies, newest first.', feedbackEmpty: 'No feedback yet', ratings: {up: 'Helpful', down: 'Not helpful'},
  reportInfo: 'The administrator will receive this AI response (up to 20,000 characters) and your explanation to investigate and improve content safety. Other conversations are not sent.',
  deletionInfo: 'The administrator will verify your identity before deleting your account, conversations and tasks, workspace and saved credentials. Submitting this request does not immediately delete data.',
  note: 'Explanation', noteHint: 'Describe the issue. Do not include passwords or other secrets.', send: 'Submit', sending: 'Submitting…',
  success: 'Request received for administrator review. Reference: ', close: 'Close', cancel: 'Cancel',
  queue: 'User support', queueInfo: 'Verify deletion requests manually. Investigate reports and update safety rules. Record an outcome only after taking the relevant action.', empty: 'No requests',
  kinds: {content: 'Content report', deletion: 'Account deletion', privacy: 'Privacy question'}, pending: 'Pending', reviewed: 'Outcome recorded', decision: 'Investigation and action taken', review: 'Record outcome',
};
