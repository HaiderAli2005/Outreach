import { spawn } from "node:child_process";

const procs = ["api", "web"].map((name) => {
  const p = spawn("npm", ["run", `dev:${name}`], { stdio: ["ignore", "pipe", "pipe"], shell: true });
  const tag = name === "api" ? "\x1b[33m[api]\x1b[0m " : "\x1b[36m[web]\x1b[0m ";
  const pipe = (s, out) => s.on("data", (d) => out.write(d.toString().replace(/^(?=.)/gm, tag)));
  pipe(p.stdout, process.stdout);
  pipe(p.stderr, process.stderr);
  p.on("exit", (code) => {
    console.log(`${tag}exited with code ${code}`);
    procs.forEach((x) => x.kill());
    process.exit(code ?? 0);
  });
  return p;
});

console.log("Starting the API on http://localhost:4000 and the web app on http://localhost:3000. Press Ctrl+C to stop.");
process.on("SIGINT", () => procs.forEach((p) => p.kill()));
