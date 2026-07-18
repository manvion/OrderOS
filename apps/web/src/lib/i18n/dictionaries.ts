/**
 * Customer-facing storefront copy, in English and French.
 *
 * A hand-built dictionary rather than next-intl's routing i18n: the storefront's
 * tenancy already rides on the host (subdomain / custom domain), and layering a
 * `/en` `/fr` path segment on top of that would fight the middleware and every
 * internal link. So the locale is a cookie, the strings live here, and both server
 * components (via `getDictionary`) and client components (via the I18nProvider) read
 * the SAME typed object — so a missing key is a compile error, not a blank on a
 * customer's screen.
 *
 * Scope is the ORDERING FLOW a diner sees: header, menu, cart, checkout, tracking,
 * catering. The owner dashboard stays English (staff-facing).
 */
export type Locale = 'en' | 'fr';

export const LOCALE_COOKIE = 'df_locale';

export interface Dictionary {
  nav: {
    menu: string;
    about: string;
    myOrders: string;
    catering: string;
  };
  menu: {
    search: string;
    empty: string;
    add: string;
    soldOut: string;
    unavailable: string;
    from: string;
    popular: string;
  };
  cart: {
    title: string;
    empty: string;
    emptyHint: string;
    subtotal: string;
    checkout: string;
    item: string;
    items: string;
    remove: string;
    browseMenu: string;
  };
  checkout: {
    title: string;
    yourDetails: string;
    name: string;
    phone: string;
    email: string;
    howToGet: string;
    pickup: string;
    delivery: string;
    dineIn: string;
    deliveryAddress: string;
    tableNumber: string;
    tip: string;
    noTip: string;
    notes: string;
    notesPlaceholder: string;
    subtotal: string;
    serviceFee: string;
    deliveryFee: string;
    tax: string;
    total: string;
    placeOrder: string;
    payAndOrder: string;
    securePayment: string;
    minOrder: string;
  };
  tracker: {
    trackYourOrder: string;
    arrivingIn: string;
    minutes: string;
    enjoy: string;
    cancelled: string;
    waitingPayment: string;
    isOnIt: string;
    giveCodeCounter: string;
    yourOrderCode: string;
    driverConfirmsCode: string;
    table: string;
    progress: string;
    orderPlaced: string;
    confirmed: string;
    preparing: string;
    readyForPickup: string;
    findingDriver: string;
    driverCollecting: string;
    onItsWay: string;
    delivered: string;
    collected: string;
    yourOrder: string;
    thanks: string;
    orderAgain: string;
    callRestaurant: string;
    aboutMinAway: string;
  };
  catering: {
    eyebrow: string;
    heading: string;
    intro: string;
    perPerson: string;
    minimum: string;
    upTo: string;
    orderThis: string;
    customTitle: string;
    customIntro: string;
    requestCustom: string;
    backToMenu: string;
    numberOfPeople: string;
    eventDate: string;
    pickupOrDelivery: string;
    deliveryAddress: string;
    yourName: string;
    phone: string;
    email: string;
    notesOptional: string;
    tellUsEvent: string;
    pay: string;
    sendRequest: string;
    afterPaying: string;
    people: string;
  };
  common: {
    pickup: string;
    delivery: string;
    dineIn: string;
    language: string;
  };
}

const en: Dictionary = {
  nav: { menu: 'Menu', about: 'About', myOrders: 'My orders', catering: 'Catering' },
  menu: {
    search: 'Search the menu',
    empty: 'Nothing on the menu yet.',
    add: 'Add',
    soldOut: 'Sold out',
    unavailable: 'Unavailable',
    from: 'from',
    popular: 'Popular',
  },
  cart: {
    title: 'Your order',
    empty: 'Your cart is empty',
    emptyHint: 'Add something from the menu to get started.',
    subtotal: 'Subtotal',
    checkout: 'Checkout',
    item: 'item',
    items: 'items',
    remove: 'Remove',
    browseMenu: 'Browse the menu',
  },
  checkout: {
    title: 'Checkout',
    yourDetails: 'Your details',
    name: 'Name',
    phone: 'Phone',
    email: 'Email',
    howToGet: 'How would you like it?',
    pickup: 'Pickup',
    delivery: 'Delivery',
    dineIn: 'Dine in',
    deliveryAddress: 'Delivery address',
    tableNumber: 'Table number',
    tip: 'Tip',
    noTip: 'No tip',
    notes: 'Notes for the kitchen',
    notesPlaceholder: 'Allergies, instructions…',
    subtotal: 'Subtotal',
    serviceFee: 'Service fee',
    deliveryFee: 'Delivery',
    tax: 'Tax',
    total: 'Total',
    placeOrder: 'Place order',
    payAndOrder: 'Pay & order',
    securePayment: 'Secure payment',
    minOrder: 'Minimum order',
  },
  tracker: {
    trackYourOrder: 'Track your order',
    arrivingIn: 'Arriving in about',
    minutes: 'min',
    enjoy: 'Enjoy your food',
    cancelled: 'This order was cancelled',
    waitingPayment: 'Waiting for payment',
    isOnIt: 'is on it',
    giveCodeCounter: 'Give this code at the counter',
    yourOrderCode: 'Your order code',
    driverConfirmsCode: 'Your driver will confirm this code',
    table: 'Table',
    progress: 'Progress',
    orderPlaced: 'Order placed',
    confirmed: 'Confirmed by the kitchen',
    preparing: 'Being prepared',
    readyForPickup: 'Ready for pickup',
    findingDriver: 'Finding a driver',
    driverCollecting: 'Driver collecting your order',
    onItsWay: 'On its way to you',
    delivered: 'Delivered',
    collected: 'Collected',
    yourOrder: 'Your order',
    thanks: 'Thanks for ordering directly with',
    orderAgain: 'Order again',
    callRestaurant: 'Call the restaurant',
    aboutMinAway: 'min away',
  },
  catering: {
    eyebrow: 'Catering & parties',
    heading: 'Feeding a crowd?',
    intro:
      'Pick a package sized to your headcount and pay online, or tell us about your event and we’ll build something custom.',
    perPerson: '/ person',
    minimum: 'Minimum',
    upTo: 'up to',
    orderThis: 'Order this',
    customTitle: 'Something more custom?',
    customIntro:
      'Dietary needs, a specific menu, a big or unusual event — tell us what you’re planning and we’ll get back to you with a quote.',
    requestCustom: 'Request custom catering',
    backToMenu: '← Back to the menu',
    numberOfPeople: 'Number of people',
    eventDate: 'Event date',
    pickupOrDelivery: 'Pickup or delivery',
    deliveryAddress: 'Delivery address',
    yourName: 'Your name',
    phone: 'Phone',
    email: 'Email',
    notesOptional: 'Notes (optional)',
    tellUsEvent: 'Tell us about your event',
    pay: 'Pay',
    sendRequest: 'Send request',
    afterPaying: 'Secure checkout. You’ll confirm details with the restaurant after paying.',
    people: 'people',
  },
  common: { pickup: 'Pickup', delivery: 'Delivery', dineIn: 'Dine in', language: 'Language' },
};

const fr: Dictionary = {
  nav: { menu: 'Menu', about: 'À propos', myOrders: 'Mes commandes', catering: 'Traiteur' },
  menu: {
    search: 'Rechercher au menu',
    empty: 'Aucun plat au menu pour l’instant.',
    add: 'Ajouter',
    soldOut: 'Épuisé',
    unavailable: 'Indisponible',
    from: 'à partir de',
    popular: 'Populaire',
  },
  cart: {
    title: 'Votre commande',
    empty: 'Votre panier est vide',
    emptyHint: 'Ajoutez quelque chose au menu pour commencer.',
    subtotal: 'Sous-total',
    checkout: 'Passer à la caisse',
    item: 'article',
    items: 'articles',
    remove: 'Retirer',
    browseMenu: 'Voir le menu',
  },
  checkout: {
    title: 'Paiement',
    yourDetails: 'Vos coordonnées',
    name: 'Nom',
    phone: 'Téléphone',
    email: 'Courriel',
    howToGet: 'Comment souhaitez-vous l’obtenir ?',
    pickup: 'À emporter',
    delivery: 'Livraison',
    dineIn: 'Sur place',
    deliveryAddress: 'Adresse de livraison',
    tableNumber: 'Numéro de table',
    tip: 'Pourboire',
    noTip: 'Aucun pourboire',
    notes: 'Notes pour la cuisine',
    notesPlaceholder: 'Allergies, instructions…',
    subtotal: 'Sous-total',
    serviceFee: 'Frais de service',
    deliveryFee: 'Livraison',
    tax: 'Taxes',
    total: 'Total',
    placeOrder: 'Passer la commande',
    payAndOrder: 'Payer et commander',
    securePayment: 'Paiement sécurisé',
    minOrder: 'Commande minimum',
  },
  tracker: {
    trackYourOrder: 'Suivre votre commande',
    arrivingIn: 'Arrive dans environ',
    minutes: 'min',
    enjoy: 'Bon appétit',
    cancelled: 'Cette commande a été annulée',
    waitingPayment: 'En attente du paiement',
    isOnIt: 's’en occupe',
    giveCodeCounter: 'Donnez ce code au comptoir',
    yourOrderCode: 'Votre code de commande',
    driverConfirmsCode: 'Votre livreur confirmera ce code',
    table: 'Table',
    progress: 'Progression',
    orderPlaced: 'Commande passée',
    confirmed: 'Confirmée par la cuisine',
    preparing: 'En préparation',
    readyForPickup: 'Prête à emporter',
    findingDriver: 'Recherche d’un livreur',
    driverCollecting: 'Le livreur récupère votre commande',
    onItsWay: 'En route vers vous',
    delivered: 'Livrée',
    collected: 'Récupérée',
    yourOrder: 'Votre commande',
    thanks: 'Merci d’avoir commandé directement chez',
    orderAgain: 'Commander à nouveau',
    callRestaurant: 'Appeler le restaurant',
    aboutMinAway: 'min',
  },
  catering: {
    eyebrow: 'Traiteur et réceptions',
    heading: 'Un groupe à nourrir ?',
    intro:
      'Choisissez une formule selon le nombre de personnes et payez en ligne, ou parlez-nous de votre événement et nous créerons du sur-mesure.',
    perPerson: '/ personne',
    minimum: 'Minimum',
    upTo: 'jusqu’à',
    orderThis: 'Commander',
    customTitle: 'Quelque chose de plus personnalisé ?',
    customIntro:
      'Besoins alimentaires, un menu précis, un événement grand ou particulier — dites-nous ce que vous planifiez et nous vous ferons une soumission.',
    requestCustom: 'Demander un service sur-mesure',
    backToMenu: '← Retour au menu',
    numberOfPeople: 'Nombre de personnes',
    eventDate: 'Date de l’événement',
    pickupOrDelivery: 'À emporter ou livraison',
    deliveryAddress: 'Adresse de livraison',
    yourName: 'Votre nom',
    phone: 'Téléphone',
    email: 'Courriel',
    notesOptional: 'Notes (facultatif)',
    tellUsEvent: 'Parlez-nous de votre événement',
    pay: 'Payer',
    sendRequest: 'Envoyer la demande',
    afterPaying:
      'Paiement sécurisé. Vous confirmerez les détails avec le restaurant après le paiement.',
    people: 'personnes',
  },
  common: {
    pickup: 'À emporter',
    delivery: 'Livraison',
    dineIn: 'Sur place',
    language: 'Langue',
  },
};

const DICTIONARIES: Record<Locale, Dictionary> = { en, fr };

export function getDictionary(locale: Locale): Dictionary {
  return DICTIONARIES[locale] ?? en;
}

/** Normalise anything (a cookie, a menuLanguage) to a supported locale. */
export function toLocale(value: string | null | undefined): Locale {
  return value === 'fr' ? 'fr' : 'en';
}
