// Helper process for concurrency.test.ts: opens the DB and creates N tasks.
import { openDb } from "../../src/store/db.ts";
import { TaskRepository } from "../../src/store/repository.ts";

const [path, label, count] = Bun.argv.slice(2);
const repo = new TaskRepository(openDb(path!));
for (let i = 0; i < Number(count); i++) repo.create({ title: `${label}-${i}`, quadrant: 2 });
