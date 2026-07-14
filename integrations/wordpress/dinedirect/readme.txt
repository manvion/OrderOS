=== DineDirect — Online Ordering ===
Contributors: dinedirect
Tags: restaurant, online ordering, food delivery, takeaway, menu
Requires at least: 5.8
Tested up to: 6.7
Requires PHP: 7.4
Stable tag: 1.0.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Take orders and payments directly on your restaurant's WordPress site. No commission to a marketplace.

== Description ==

Add online ordering to your existing WordPress site. Your customers browse the menu,
pay, and track their order **without ever leaving your website**.

* Pickup, delivery and dine-in
* Card payments via Stripe — money goes straight to your account
* Delivery by Uber courier, dispatched automatically when you mark an order ready
* Live order tracking for your customers
* No marketplace taking 30% of every order

This plugin adds one small script to your site. Everything else — your menu,
prices, opening hours, and how the ordering button looks — is managed in your
DineDirect dashboard, so you never edit your website again to change them.

You need an DineDirect account. Sign up at https://dinedirect.manvion.ca.

== Installation ==

1. Upload the plugin, or install it from the Plugins screen.
2. Activate it.
3. Go to **Settings → DineDirect**.
4. Paste your widget key (find it in your DineDirect dashboard, under **My website**).
   You can paste the whole code snippet — the plugin will pull the key out of it.
5. Save, then load your homepage. The order button should appear.

**Important:** register this site's domain in your DineDirect dashboard under
**My website**. The widget only runs on domains you register — that's what stops
anyone else from copying your ordering widget onto their own site.

== Frequently Asked Questions ==

= Do my customers leave my website to order? =

No. The menu, cart and order tracking all happen on your site. Payment opens in a
new tab (Stripe does not allow its payment page to be embedded in another site —
this is a security feature, and a good one), and the tab on your website flips to
live order tracking the moment payment goes through.

= Where do I put the button? =

By default it floats in the corner of every page. You can change the position,
colour and text in your DineDirect dashboard, with no changes to WordPress.

If you'd rather place it yourself, use the shortcodes:

* `[dinedirect_menu]` — embeds your live menu in the page.
* `[dinedirect_button text="Order Now"]` — a button styled by your theme.

= The button isn't showing up. =

1. Check that this site's domain is registered in your DineDirect dashboard under
   **My website**. If your site is on `www.`, we handle that automatically — but a
   staging or preview domain is a different domain and needs registering separately.
2. Check that your ordering page is published in DineDirect (Settings → Publish).
3. If you use a caching plugin (WP Rocket, W3 Total Cache, LiteSpeed), clear the
   cache after saving.
4. Open your browser console — we log the exact reason there, and never show an
   error to your customers.

= Is my widget key a secret? =

No, and it doesn't need to be. It sits in your page source where anyone can read
it. What protects you is the domain allowlist: a copy of your key on anyone else's
website simply won't work.

= Does it slow my site down? =

The script is about 9KB and loads deferred, after your page has rendered. It loads
no fonts and no frameworks onto your site.

== Changelog ==

= 1.0.0 =
* First release. Floating button, inline menu, custom-button modes; shortcodes;
  settings screen with key validation.
