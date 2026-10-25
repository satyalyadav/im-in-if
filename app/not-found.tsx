import Link from "next/link";

export default function NotFound() {
  return (
    <main className="page">
      <section className="narrow">
        <h1>That page is not here.</h1>
        <p className="lede">
          An outing is visible only to the account that started it. If you followed a link,
          sign in with the right account or start a new outing.
        </p>
        <Link className="button button-solid" href="/">
          Back to the start
        </Link>
      </section>
    </main>
  );
}
