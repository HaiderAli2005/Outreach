import { execSync, spawn } from "node:child_process";

if (process.env.APERTURE_NO_DOCKER !== "1") {
  const compose = "docker compose -f infra/docker-compose.yml";
  try {
    console.log("Starting the database and Redis in Docker...");
    execSync(`${compose} up -d postgres redis`, { stdio: "inherit" });
  } catch {
    console.error("\nDocker Desktop isn't running. Open Docker Desktop, wait until it says Engine running, then run npm run dev again.");
    process.exit(1);
  }
  for (let i = 0; ; i++) {
    try {
      execSync(`${compose} exec -T postgres pg_isready -U aperture -d aperture`, { stdio: "ignore" });
      break;
    } catch {
      if (i >= 30) {
        console.error("\nThe database container started but isn't answering. Check it in Docker Desktop, then run npm run dev again.");
        process.exit(1);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

try {
  console.log("Applying any new database migrations (existing data is kept) and updating the database client...");
  execSync("npm run prisma:deploy -w apps/server", { stdio: "inherit" });
} catch {
  console.error("\nCould not update the database. Check Docker Desktop is running and apps/server/.env exists (npm run setup creates it), then try again.");
  process.exit(1);
}
try {
  execSync("npm exec -w apps/server -- prisma generate", { stdio: "inherit" });
} catch {
  console.error("\nCould not update the database client. Close every other terminal running Aperture (the API keeps the client open), then run npm run dev again.");
  process.exit(1);
}

const procs = ["server", "client"].map((name) => {
  const p = spawn("npm", ["run", `dev:${name}`], { stdio: ["ignore", "pipe", "pipe"], shell: true });
  const tag = name === "server" ? "\x1b[33m[server]\x1b[0m " : "\x1b[36m[client]\x1b[0m ";
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

console.log("Starting the API on http://localhost:4000 and the web app on http://localhost:3100. Press Ctrl+C to stop.");
process.on("SIGINT", () => procs.forEach((p) => p.kill()));
