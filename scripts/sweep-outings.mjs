const url = process.env.SCHEDULER_URL ?? "http://localhost:3000/api/maintenance/sweep";
const secret = process.env.SCHEDULER_SECRET;

if (!secret) {
  process.stderr.write("SCHEDULER_SECRET is required.\n");
  process.exitCode = 2;
} else {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      process.stderr.write(`The sweep endpoint returned HTTP ${response.status}.\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }
  } catch {
    process.stderr.write("The sweep endpoint could not be reached.\n");
    process.exitCode = 1;
  }
}
