const post = (kind, extra = {}) => fetch(`${process.env.ORCHESTRA_HOOK_URL}/${kind}`, {
  method: 'POST',
  body: JSON.stringify({ hook_event_name: kind, session_id: 'mock-session', turn_id: 'mock-turn', ...extra }),
});

async function run() {
  process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  let input = '';
  process.stdin.on('data', async (data) => {
    if (data.includes('\x03')) process.exit(0);
    input += data;
    if (!input.includes('\x1b[201~\r')) return;
    await post('SessionStart');
    await post('UserPromptSubmit');
    process.stdout.write('\r\nCHILD OUTPUT: ' + input.match(/\x1b\[200~(.*?)\x1b\[201~/s)[1] + '\r\n');
    input = '';
    setTimeout(() => post('Stop', { last_assistant_message: 'Child summary' }), 1500);
  });
  process.stdout.write('Child terminal ready\r\n\x1b[?2004h');
}

run().catch((error) => { console.error(error.message); process.exit(1); });
