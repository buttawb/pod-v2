import { Controller, Get, Header, VERSION_NEUTRAL } from '@nestjs/common';
import { Public } from '../../common/auth/jwt-auth.guard';

/**
 * The privacy policy Google Play links to from the store listing.
 *
 * Served by the API rather than the dashboard SPA for two reasons. The SPA's
 * catch-all (`try_files {path} /index.html` in the Caddyfile) would answer
 * /privacy with the office dashboard, which bounces to a login - and Play
 * requires this page to be readable with no authentication. And Play
 * re-checks the URL after launch, removing apps whose policy goes dead, so
 * the page should not be something a dashboard rebuild can quietly break.
 *
 * The document is a template literal rather than a static file because the
 * Dockerfile copies only `src` and ships the compiled `dist`; a .html asset
 * would need a build step to survive into the image, and a privacy policy
 * that 404s in production is the one failure mode worth engineering out.
 */
@Controller({ path: 'privacy', version: VERSION_NEUTRAL })
export class PrivacyController {
  @Public()
  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'public, max-age=3600')
  // Set explicitly rather than inherited from helmet's default, which is
  // tuned for an API. This page loads nothing at all: no scripts, no fonts,
  // no images, one inline stylesheet.
  @Header(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  )
  page(): string {
    return PRIVACY_POLICY_HTML;
  }
}

/** Shown on the page, and the date Play's reviewers check against. */
const LAST_UPDATED = '12 August 2026';
const CONTACT_EMAIL = 'buttawb@gmail.com';

const PRIVACY_POLICY_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Privacy Policy &mdash; PoD v2</title>
<style>
  :root {
    --ground: #ffffff;
    --ink: #14181d;
    --ink-2: #4a555f;
    --line: #dde3e9;
    --wash: #f4f7fa;
    --accent: #0b5fd6;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --ground: #0f1418;
      --ink: #e6ecf2;
      --ink-2: #a4b0bb;
      --line: #28313a;
      --wash: #171e25;
      --accent: #6da5ff;
    }
  }
  * { box-sizing: border-box; }
  body {
    background: var(--ground);
    color: var(--ink);
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
    line-height: 1.65;
    margin: 0 auto;
    max-width: 46rem;
    padding: 2.5rem 1.25rem 5rem;
  }
  h1 { font-size: 1.85rem; line-height: 1.2; margin: 0 0 .4rem; }
  h2 { font-size: 1.15rem; margin: 2.4rem 0 .6rem; }
  p, li { color: var(--ink-2); }
  p { margin: 0 0 1rem; }
  ul { padding-left: 1.2rem; }
  li { margin-bottom: .4rem; }
  a { color: var(--accent); }
  .meta {
    color: var(--ink-2);
    font-size: .875rem;
    border-bottom: 1px solid var(--line);
    padding-bottom: 1.25rem;
    margin-bottom: .5rem;
  }
  .meta strong { color: var(--ink); font-weight: 600; }
  .table-wrap { overflow-x: auto; margin: 0 0 1rem; }
  table { border-collapse: collapse; width: 100%; font-size: .9rem; min-width: 34rem; }
  th, td {
    text-align: left;
    padding: .55rem .7rem;
    border-bottom: 1px solid var(--line);
    vertical-align: top;
  }
  th { background: var(--wash); color: var(--ink); font-size: .78rem; text-transform: uppercase; letter-spacing: .05em; }
  td { color: var(--ink-2); }
  footer { margin-top: 3rem; padding-top: 1.25rem; border-top: 1px solid var(--line); font-size: .875rem; color: var(--ink-2); }
</style>
</head>
<body>

<h1>PoD v2 &mdash; Privacy Policy</h1>
<p class="meta">
  Applies to the Android app <strong>PoD v2 &mdash; Driver</strong>
  (<strong>com.podv2.driver</strong>) and the office dashboard it reports to.<br>
  Last updated <strong>${LAST_UPDATED}</strong>.
</p>

<h2>Who this policy is for</h2>
<p>
  PoD v2 is a workforce app used by delivery drivers to record proof that a
  parcel was delivered. It is issued by an employer; there is no public sign-up.
  This policy covers two groups of people: the <strong>drivers</strong> who use
  the app, and the <strong>recipients</strong> whose deliveries are recorded.
</p>
<p>
  The data controller is <strong>PoD</strong>. Questions, or any request about
  your data, go to
  <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.
</p>

<h2>What the app collects</h2>
<p>
  Everything below is recorded at the moment a driver saves a delivery attempt.
  Nothing is collected in the background, and the app does not run when it is
  closed.
</p>
<div class="table-wrap">
<table>
  <thead>
    <tr><th>Data</th><th>Why it is held</th></tr>
  </thead>
  <tbody>
    <tr>
      <td>Precise location (latitude, longitude and accuracy)</td>
      <td>Records where a delivery attempt was made. Captured once per attempt, never as a continuous trace.</td>
    </tr>
    <tr>
      <td>Photographs of the delivery</td>
      <td>For several outcomes the photograph is the proof &mdash; a parcel in a safe place, a card through a door.</td>
    </tr>
    <tr>
      <td>Signature image</td>
      <td>Proof that a parcel was handed to a person. It is an image of a signature, not a name.</td>
    </tr>
    <tr>
      <td>Driver name and employee reference</td>
      <td>Attributes each piece of evidence to the person who captured it.</td>
    </tr>
    <tr>
      <td>Delivery address and postcode</td>
      <td>Needed to deliver the parcel and to identify which delivery the evidence belongs to.</td>
    </tr>
    <tr>
      <td>A neighbour's house number</td>
      <td>Recorded only when a parcel is left with a neighbour, so the recipient can be told where it is.</td>
    </tr>
    <tr>
      <td>Parcel barcode, outcome and timestamps</td>
      <td>Identifies the parcel and what happened to it.</td>
    </tr>
    <tr>
      <td>A short note typed by the driver</td>
      <td>Optional context for the office, such as which side of the porch a parcel was left on.</td>
    </tr>
    <tr>
      <td>A device installation identifier</td>
      <td>A random identifier generated when the app is installed. It tells devices apart and shows which device evidence came from. It is not a hardware identifier and cannot identify the handset itself.</td>
    </tr>
    <tr>
      <td>App version</td>
      <td>Lets the server refuse evidence from a build with a known defect.</td>
    </tr>
  </tbody>
</table>
</div>

<h2>What the app deliberately does not collect</h2>
<ul>
  <li><strong>No recipient names.</strong> There is no name field. The "person" in a hand-to-hand delivery is a signature image; a neighbour is a house number.</li>
  <li><strong>No recipient contact details.</strong> There is no phone or email field anywhere in the system.</li>
  <li><strong>No driver location history.</strong> Position is recorded per delivery attempt only. Drivers are not tracked between stops, and the office dashboard shows delivery status, not driver movement.</li>
  <li><strong>No location inside photographs.</strong> Embedded metadata is stripped from every photograph on the phone, before it is saved or uploaded.</li>
  <li><strong>No advertising identifier, no analytics, no tracking.</strong> The app contains no advertising or analytics software of any kind, and no data is used for advertising, marketing or profiling.</li>
  <li><strong>No addresses or names on the depot map.</strong> The map carries coordinates, a status code and a sequence number only.</li>
</ul>

<h2>Permissions the app asks for</h2>
<ul>
  <li><strong>Camera</strong> &mdash; to photograph delivery evidence and scan parcel barcodes. Used only while a driver is recording a delivery attempt.</li>
  <li><strong>Location</strong> &mdash; to record where a delivery attempt was made. Requested while the app is in use; the app never requests background location and cannot read your position when it is closed.</li>
</ul>
<p>
  Both permissions can be declined or withdrawn in Android settings. Declining
  the camera prevents photographs being captured, and declining location means
  an attempt is recorded without a position.
</p>

<h2>Why this data is held</h2>
<p>
  To perform the delivery contract, and on the basis of legitimate interest in
  being able to defend customer disputes and insurance claims. Proof of delivery
  exists precisely so that a later question &mdash; was this parcel delivered,
  and where &mdash; can be answered with evidence.
</p>

<h2>Who it is shared with</h2>
<p>
  This data is not sold, and it is not shared with anyone for their own
  purposes. It is processed on our behalf by:
</p>
<ul>
  <li><strong>Amazon Web Services</strong> &mdash; hosting, and storage of photographs and signatures in a private bucket that is never publicly readable.</li>
  <li><strong>Amazon Bedrock</strong> &mdash; used to draft a plain-English delivery summary for the customer. Only the driver's short note and the delivery outcome are sent. Never a photograph, a signature, an address, a postcode, a location, a parcel identifier or a driver name; phone numbers and email addresses are removed from the note before it is sent. Every generated summary is reviewed by a person before it reaches anyone.</li>
</ul>
<p>Data may also be disclosed where the law requires it.</p>

<h2>How long it is kept</h2>
<p>
  <strong>18 months</strong>, which covers the practical window for courier
  claims and disputes. Photographs and signatures are deleted automatically by a
  storage lifecycle rule at the end of that period &mdash; deletion is enforced
  by the infrastructure itself and does not depend on anyone remembering to run
  anything.
</p>

<h2>How it is protected</h2>
<ul>
  <li>Encrypted in transit end to end. Photographs upload straight to private storage, and non-encrypted requests are refused by policy.</li>
  <li>Photographs and signatures are never served from a public address. Viewing one requires an authenticated request and produces a link that expires in five minutes.</li>
  <li>Evidence is append-only. The application's database account holds no permission to change or delete it.</li>
  <li>Drivers can read and write only their own stops and attempts.</li>
  <li>Sign-in credentials are held in the phone's hardware-backed secure storage.</li>
</ul>

<h2>Your rights</h2>
<p>
  Under UK GDPR you may ask for a copy of your data, ask for inaccurate data to
  be corrected, object to how it is used, or ask for it to be erased. Write to
  <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a> and we will respond
  within one month.
</p>
<p>
  One limit is worth stating plainly. Proof of delivery is evidence, and while
  it is still needed to establish or defend a legal claim it is exempt from
  erasure under Article 17(3)(e). An erasure request made inside the 18-month
  retention window will receive that exemption, together with the date on which
  the evidence will be destroyed automatically. After that date there is nothing
  left to erase.
</p>
<p>
  If you are unhappy with how we have handled your data you can complain to the
  Information Commissioner's Office at
  <a href="https://ico.org.uk/make-a-complaint/">ico.org.uk/make-a-complaint</a>.
</p>

<h2>Children</h2>
<p>
  PoD v2 is a tool for employed delivery drivers. It is not directed at children
  and is not intended for anyone under 18.
</p>

<h2>Changes to this policy</h2>
<p>
  If this policy changes, the date at the top of the page changes with it, and
  the current version is always the one published here.
</p>

<footer>
  PoD v2 &mdash; com.podv2.driver &mdash; last updated ${LAST_UPDATED}.<br>
  Contact: <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>
</footer>

</body>
</html>
`;
