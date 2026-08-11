# Privacy and data protection

Proof-of-delivery data is personal data under UK GDPR: photographs of
people's homes, delivery addresses, signatures, and GPS traces of where
employees were and when. This file is the data map a regulator would ask
for.

## What is held, and where

| Data | Where | Why it exists |
|---|---|---|
| Delivery address, postcode | Postgres `stops` | Required to deliver the parcel |
| Attempt outcome, timestamps, GPS + accuracy | Postgres `delivery_attempts` | The proof itself; used in disputes and insurance claims |
| Photographs, signature images | Private S3 bucket, `attempts/{client_attempt_id}/*` | The proof itself |
| Driver display name, employee reference | Postgres `drivers` | Attribution of evidence to the person who captured it |
| Device install ID | Postgres `devices` | Provenance of evidence, and multi-device detection |
| Free-text driver note | Postgres `delivery_attempts.note` | Operational context for the office |

## What is deliberately NOT held

- **No recipient names.** The "person" in *delivered to person* is a
  signature image, not a name field. A neighbour is a house number.
- **No recipient contact details.** There is no phone or email column.
- **No driver location history.** Position is recorded per attempt, never
  as a continuous trace, and the office dashboard shows delivery status,
  not driver movement.
- **No EXIF.** Photographs are captured with EXIF disabled; GPS lives in
  typed columns where it can be governed, not smuggled inside image
  metadata where it cannot.
- **No addresses or names in the map payload.** The depot map carries
  coordinates, a status code and a sequence number only.

## Lawful basis and retention

Holding proof of delivery rests on legitimate interest: defending customer
disputes and insurance claims, and performing the delivery contract.

**Retention is 18 months**, which covers the practical courier claims
window. After that an automated job destroys the evidence: S3 objects
(including versions) are deleted, free-text and neighbour fields are
nulled, and GPS is truncated to two decimal places. A tombstone row
records that evidence existed and when it was destroyed, which is itself
useful in a dispute.

## Erasure requests versus immutable evidence

These reconcile through retention rather than through mutating evidence.
Article 17(3)(e) exempts data needed for the establishment or defence of
legal claims from erasure while that need lasts. So an erasure request
inside the retention window receives that exemption together with the
scheduled destruction date; anything not claim-relevant is redacted
immediately.

Crypto-shredding was considered and rejected: it needs one key per data
subject, and parcel recipients are not modelled entities here, so it would
mean thousands of KMS keys per day to achieve something that versioned S3
deletion plus a tombstone already proves more simply and more auditably.

## Access controls

- **Object storage.** The evidence bucket blocks all public access, denies
  non-TLS requests by policy, and has versioning enabled. Nothing is ever
  served from a public URL. Viewing evidence goes through an authenticated
  endpoint that mints a five-minute presigned GET, so every view passes
  authorisation.
- **No static credentials.** The API reaches S3 and Bedrock through an EC2
  instance role scoped to `attempts/*` and model invocation. There is no
  AWS key anywhere in the repository, the images, or the environment.
- **Least privilege in the database.** The runtime role holds INSERT and
  SELECT on evidence tables and column-level UPDATE on two bookkeeping
  columns. It cannot UPDATE or DELETE evidence even if application code
  regresses.
- **Per-record authorisation.** Drivers can only read or write their own
  stops and attempts; ownership is checked on every route that takes an
  identifier.
- **Transport.** HTTPS end to end, HSTS enabled, with security headers set
  by helmet.

## What is sent to the model provider

The customer-summary feature sends **only** the driver's free-text note and
the outcome code to AWS Bedrock. Never a photograph, a signature, an
address, a postcode, a GPS coordinate, a parcel identifier, or a driver
name. Phone numbers and email addresses are stripped from the note before
it leaves the system.

Three reasons: the call carries no personal data, so provider-side
invocation logging holds none either; a malicious note cannot exfiltrate
what the model was never given; and the output goes to a customer who
already knows their own address, so it never needed one.

Generated text is stored as a **draft**. It is shown to office staff marked
for review, and reaching a customer requires a named human to read it and
click send. The model's original wording is retained immutably alongside
any human edit, so an audit can always separate what the model said from
what a person approved.
