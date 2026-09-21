/**
 * Wipe every answer off a running wall — local or Azure.
 *
 *   node scripts/clear.mjs https://example.azurewebsites.net <admin-key>
 *
 * Intended for the minutes before a session starts, when early arrivals have
 * already submitted and you want a blank wall. Deletes through the same admin
 * API the moderation page uses, so connected projectors update live over SSE.
 */
const [, , rawBase, adminKey] = process.argv;

if (!rawBase || !adminKey) {
  console.error('usage: node scripts/clear.mjs <base-url> <admin-key>');
  process.exit(2);
}

const base = rawBase.replace(/\/+$/, '');

const listAnswers = async () => {
  const response = await fetch(`${base}/api/answers`);
  if (!response.ok) {
    throw new Error(`GET /api/answers returned ${response.status}`);
  }
  const body = await response.json();
  return body.entries ?? [];
};

const removeAnswer = async (id) => {
  const response = await fetch(`${base}/api/answers/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { 'x-admin-key': adminKey },
  });
  if (response.status === 401) {
    throw new Error('admin key rejected');
  }
  return response.ok || response.status === 404;
};

const main = async () => {
  const entries = await listAnswers();

  if (entries.length === 0) {
    console.log('Wall is already clear.');
    return;
  }

  console.log(`Clearing ${entries.length} answer(s) from ${base}`);

  let removed = 0;
  for (const entry of entries) {
    if (await removeAnswer(entry.id)) {
      removed += 1;
      console.log(`  removed [${entry.question}] ${entry.text}`);
    } else {
      console.log(`  FAILED  [${entry.question}] ${entry.text}`);
    }
  }

  const left = await listAnswers();
  console.log(`\nRemoved ${removed}. ${left.length} answer(s) remaining.`);

  if (left.length > 0) {
    process.exitCode = 1;
  }
};

main().catch((error) => {
  console.error(`clear failed: ${error.message}`);
  process.exit(1);
});
