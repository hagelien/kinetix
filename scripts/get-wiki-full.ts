import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL!);
const id = Number(process.argv[2]);
const rows = await sql`SELECT id, title, content FROM wiki_pages WHERE id = ${id}`;
console.log(JSON.stringify(rows[0]));
