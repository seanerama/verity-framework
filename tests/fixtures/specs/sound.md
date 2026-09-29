# Order Desk: a counter-side order log for a single bakery

## Goal
Replace the paper order book: staff record customer pre-orders at the counter
and see what is due for pickup each day.

## Users
- **Counter staff** (2–4 people, shared tablet): create, edit and mark orders
  picked up.
- **Owner** (1 person): everything staff can do, plus the daily summary.

## Core flows
1. Staff create an order: customer name, phone, items with quantities, pickup date.
2. Staff open "Due today" and mark each order picked up.
3. The owner opens the daily summary: orders due, picked up, and outstanding.

## Data kept
- `orders`: id, customer_name, customer_phone, pickup_date, status
  (`open` | `picked_up`), created_at.
- `order_items`: order_id, item_name, quantity.
Nothing else is stored; no payment data.

## Constraints
- Single-tenant web app on one small server; SQLite is enough.
- Works on a tablet browser; no native app.
- No external integrations in v1.

## Done looks like
- All three flows work end to end in a browser.
- `npm test` passes with tests for order create, due-today and mark-picked-up.
- The daily summary numbers match the orders table for a seeded day.
