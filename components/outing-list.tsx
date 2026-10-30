import Link from "next/link";
import type { OutingView } from "@/lib/outings-api";

export function OutingList({ outings }: { outings: OutingView[] }) {
  return (
    <section className="recent" aria-labelledby="recent-heading">
      <h2 id="recent-heading">Your outings</h2>
      <ul>
        {outings.map((outing) => (
          <li key={outing.id}>
            <Link href={`/outings/${outing.id}`}>
              <span className="recent-title">{outing.suggestion}</span>
              <span className="recent-meta">
                {outing.cutoffDisplay ? `Replies stop ${outing.cutoffDisplay}` : "No response cutoff"}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
