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
    notReady: string;
    checkBack: string;
  };
  cart: {
    title: string;
    empty: string;
    emptyHint: string;
    subtotal: string;
    checkout: string;
    browseMenu: string;
    discount: string;
    applied: string;
    promoCode: string;
    apply: string;
    checking: string;
    feesNote: string;
    addMore: string;
    minimumNotMet: string;
    minPrefix: string;
    minSuffix: string;
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
    deliveredToYou: string;
    collectFromUs: string;
    dineInWithUs: string;
    orderingForTable: string;
    mobileNumber: string;
    willText: string;
    whereBring: string;
    savedAddresses: string;
    city: string;
    state: string;
    zip: string;
    checkingDelivery: string;
    saveAddress: string;
    tooFar: string;
    switchToPickup: string;
    canDeliverFor: string;
    arrivingAround: string;
    when: string;
    asap: string;
    scheduleLater: string;
    addTip: string;
    tipNone: string;
    notesForRestaurant: string;
    summary: string;
    discount: string;
    pay: string;
    takingToPayment: string;
    redirectNote: string;
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
  orders: {
    title: string;
    subtitle: string;
    pointsBalance: string;
    noOrders: string;
    noOrdersHint: string;
    findYourOrder: string;
    findDesc: string;
    orderNumber: string;
    orderNumberHint: string;
    phoneUsed: string;
    findingIt: string;
    findMyOrder: string;
    orderALot: string;
    createAccountPitch: string;
    createAccount: string;
    stillStuck: string;
    call: string;
  };
  about: {
    aboutPrefix: string;
    openingHours: string;
    openNow: string;
    closedNow: string;
    today: string;
    closed: string;
    howToOrder: string;
    pickup: string;
    delivery: string;
    dineIn: string;
    pickupBody: string;
    deliveryBody: string;
    dineInBody: string;
    findUs: string;
    address: string;
    getDirections: string;
    getInTouch: string;
    contactPitch: string;
    moneyPitch1: string;
    moneyPitch2: string;
    seeMenu: string;
    monday: string;
    tuesday: string;
    wednesday: string;
    thursday: string;
    friday: string;
    saturday: string;
    sunday: string;
  };
  kitchen: {
    title: string;
    loading: string;
    ordersOnPass: string;
    soundOn: string;
    soundOff: string;
    soundOnTitle: string;
    soundOffTitle: string;
    fullScreen: string;
    soundOffBanner: string;
    nothingHere: string;
    colNew: string;
    colCooking: string;
    colReady: string;
    accept: string;
    startPreparing: string;
    ready: string;
    pickedUp: string;
    pickup: string;
    delivery: string;
    dineIn: string;
    table: string;
    justNow: string;
    noEta: string;
    anyMoment: string;
    readyIn: string;
    min: string;
    newOrders: string;
    couldNotUpdate: string;
    couldNotEta: string;
  };
  common: {
    pickup: string;
    delivery: string;
    dineIn: string;
    language: string;
  };
}

const en: Dictionary = {
  nav: { menu: 'Menu', about: 'About', myOrders: 'My orders', catering: 'Party orders' },
  menu: {
    notReady: 'The menu isn’t ready yet',
    checkBack: 'Please check back shortly.',
  },
  cart: {
    title: 'Your order',
    empty: 'Your cart is empty',
    emptyHint: 'Add something from the menu to get started.',
    subtotal: 'Subtotal',
    checkout: 'Checkout',
    browseMenu: 'Browse the menu',
    discount: 'Discount',
    applied: 'applied',
    promoCode: 'Promo code',
    apply: 'Apply',
    checking: 'Checking…',
    feesNote: 'Tax, fees and any tip are calculated at checkout.',
    addMore: 'Add more',
    minimumNotMet: 'Minimum not met',
    minPrefix: 'Minimum order is',
    minSuffix: '— add more to check out.',
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
    deliveredToYou: 'Delivered to you',
    collectFromUs: 'Collect from us',
    dineInWithUs: 'Dine in with us',
    orderingForTable: 'Ordering for table',
    mobileNumber: 'Mobile number',
    willText: 'We’ll text you when your order is ready.',
    whereBring: 'Where should we bring it?',
    savedAddresses: 'Saved addresses',
    city: 'City',
    state: 'State',
    zip: 'ZIP',
    checkingDelivery: 'Checking delivery…',
    saveAddress: 'Save this address for next time',
    tooFar: 'Too far to deliver',
    switchToPickup: 'Switch to pickup instead',
    canDeliverFor: 'We can deliver here for',
    arrivingAround: 'arriving around',
    when: 'When?',
    asap: 'As soon as possible',
    scheduleLater: 'Schedule for later',
    addTip: 'Add a tip',
    tipNone: 'None',
    notesForRestaurant: 'Notes for the restaurant',
    summary: 'Summary',
    discount: 'Discount',
    pay: 'Pay',
    takingToPayment: 'Taking you to payment…',
    redirectNote: 'You’ll be redirected to a secure payment page. We never see your card details.',
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
  orders: {
    title: 'Your orders',
    subtitle: 'Track an order, or reorder a favourite.',
    pointsBalance: 'Your points balance',
    noOrders: 'No orders yet',
    noOrdersHint: 'Your orders will appear here once you’ve placed one.',
    findYourOrder: 'Find your order',
    findDesc: 'We texted you a tracking link when you ordered. Lost it? Look it up here.',
    orderNumber: 'Order number',
    orderNumberHint: 'It’s in the text and the email we sent you.',
    phoneUsed: 'The phone number you used',
    findingIt: 'Finding it…',
    findMyOrder: 'Find my order',
    orderALot: 'Order a lot?',
    createAccountPitch:
      'Create an account and your orders are always here — no lookup, and your address is saved for next time.',
    createAccount: 'Create an account',
    stillStuck: 'Still stuck?',
    call: 'Call',
  },
  about: {
    aboutPrefix: 'About',
    openingHours: 'Opening hours',
    openNow: 'Open right now',
    closedNow: 'Closed right now',
    today: 'today',
    closed: 'Closed',
    howToOrder: 'How to order',
    pickup: 'Pickup',
    delivery: 'Delivery',
    dineIn: 'Dine in',
    pickupBody: 'Order ahead and collect. Usually ready in a few minutes.',
    deliveryBody: 'We bring it to you. You can follow your driver on a live map the whole way.',
    dineInBody: 'Scan the code on your table and order from your phone. No waiting to catch an eye.',
    findUs: 'Find us',
    address: 'Address',
    getDirections: 'Get directions',
    getInTouch: 'Get in touch',
    contactPitch:
      'Something wrong with an order? Call us — we’d much rather fix it than have you leave unhappy.',
    moneyPitch1: 'When you order here, your money goes to this kitchen.',
    moneyPitch2:
      'Delivery apps take up to 30% of every order. Ordering direct means the people who cooked your food keep what you paid for it.',
    seeMenu: 'See the menu',
    monday: 'Monday',
    tuesday: 'Tuesday',
    wednesday: 'Wednesday',
    thursday: 'Thursday',
    friday: 'Friday',
    saturday: 'Saturday',
    sunday: 'Sunday',
  },
  kitchen: {
    title: 'Kitchen',
    loading: 'Loading…',
    ordersOnPass: 'orders on the pass',
    soundOn: 'Sound on',
    soundOff: 'Sound off',
    soundOnTitle: 'Sound is on',
    soundOffTitle: 'Sound is OFF — new orders will be silent',
    fullScreen: 'Full screen',
    soundOffBanner: 'Sound is off. New orders will arrive silently.',
    nothingHere: 'Nothing here',
    colNew: 'New',
    colCooking: 'Cooking',
    colReady: 'Ready',
    accept: 'Accept',
    startPreparing: 'Start preparing',
    ready: 'Ready',
    pickedUp: 'Picked up',
    pickup: 'Pickup',
    delivery: 'Delivery',
    dineIn: 'Dine in',
    table: 'Table',
    justNow: 'just now',
    noEta: 'No ETA set',
    anyMoment: 'Any moment now',
    readyIn: 'Ready in',
    min: 'min',
    newOrders: 'new order(s)',
    couldNotUpdate: 'Could not update the order',
    couldNotEta: 'Could not update the ETA',
  },
  common: { pickup: 'Pickup', delivery: 'Delivery', dineIn: 'Dine in', language: 'Language' },
};

const fr: Dictionary = {
  nav: { menu: 'Menu', about: 'À propos', myOrders: 'Mes commandes', catering: 'Réceptions' },
  menu: {
    notReady: 'Le menu n’est pas encore prêt',
    checkBack: 'Revenez bientôt.',
  },
  cart: {
    title: 'Votre commande',
    empty: 'Votre panier est vide',
    emptyHint: 'Ajoutez quelque chose au menu pour commencer.',
    subtotal: 'Sous-total',
    checkout: 'Passer à la caisse',
    browseMenu: 'Voir le menu',
    discount: 'Rabais',
    applied: 'appliqué',
    promoCode: 'Code promo',
    apply: 'Appliquer',
    checking: 'Vérification…',
    feesNote: 'Les taxes, frais et pourboire sont calculés au paiement.',
    addMore: 'Ajouter d’autres articles',
    minimumNotMet: 'Minimum non atteint',
    minPrefix: 'La commande minimum est de',
    minSuffix: '— ajoutez-en pour commander.',
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
    deliveredToYou: 'Livré chez vous',
    collectFromUs: 'À récupérer chez nous',
    dineInWithUs: 'Sur place chez nous',
    orderingForTable: 'Commande pour la table',
    mobileNumber: 'Numéro de téléphone',
    willText: 'Nous vous enverrons un texto quand votre commande sera prête.',
    whereBring: 'Où devons-nous l’apporter ?',
    savedAddresses: 'Adresses enregistrées',
    city: 'Ville',
    state: 'Province',
    zip: 'Code postal',
    checkingDelivery: 'Vérification de la livraison…',
    saveAddress: 'Enregistrer cette adresse pour la prochaine fois',
    tooFar: 'Trop loin pour la livraison',
    switchToPickup: 'Passer à la cueillette',
    canDeliverFor: 'Nous pouvons livrer ici pour',
    arrivingAround: 'arrivée vers',
    when: 'Quand ?',
    asap: 'Dès que possible',
    scheduleLater: 'Planifier pour plus tard',
    addTip: 'Ajouter un pourboire',
    tipNone: 'Aucun',
    notesForRestaurant: 'Notes pour le restaurant',
    summary: 'Récapitulatif',
    discount: 'Rabais',
    pay: 'Payer',
    takingToPayment: 'Redirection vers le paiement…',
    redirectNote:
      'Vous serez redirigé vers une page de paiement sécurisée. Nous ne voyons jamais vos informations de carte.',
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
  orders: {
    title: 'Vos commandes',
    subtitle: 'Suivez une commande ou recommandez un favori.',
    pointsBalance: 'Votre solde de points',
    noOrders: 'Aucune commande',
    noOrdersHint: 'Vos commandes apparaîtront ici une fois que vous en aurez passé une.',
    findYourOrder: 'Trouver votre commande',
    findDesc: 'Nous vous avons envoyé un lien de suivi par texto. Perdu ? Retrouvez-le ici.',
    orderNumber: 'Numéro de commande',
    orderNumberHint: 'Il est dans le texto et le courriel que nous vous avons envoyés.',
    phoneUsed: 'Le numéro de téléphone utilisé',
    findingIt: 'Recherche…',
    findMyOrder: 'Trouver ma commande',
    orderALot: 'Vous commandez souvent ?',
    createAccountPitch:
      'Créez un compte et vos commandes sont toujours ici — sans recherche, et votre adresse est enregistrée pour la prochaine fois.',
    createAccount: 'Créer un compte',
    stillStuck: 'Toujours coincé ?',
    call: 'Appeler',
  },
  about: {
    aboutPrefix: 'À propos de',
    openingHours: 'Heures d’ouverture',
    openNow: 'Ouvert maintenant',
    closedNow: 'Fermé en ce moment',
    today: 'aujourd’hui',
    closed: 'Fermé',
    howToOrder: 'Comment commander',
    pickup: 'À emporter',
    delivery: 'Livraison',
    dineIn: 'Sur place',
    pickupBody: 'Commandez à l’avance et venez chercher. Habituellement prêt en quelques minutes.',
    deliveryBody:
      'Nous vous l’apportons. Vous pouvez suivre votre livreur sur une carte en direct tout le long.',
    dineInBody:
      'Scannez le code à votre table et commandez depuis votre téléphone. Aucune attente pour attirer l’attention.',
    findUs: 'Nous trouver',
    address: 'Adresse',
    getDirections: 'Obtenir l’itinéraire',
    getInTouch: 'Nous joindre',
    contactPitch:
      'Un problème avec une commande ? Appelez-nous — nous préférons de loin la corriger que de vous voir partir mécontent.',
    moneyPitch1: 'Quand vous commandez ici, votre argent va à cette cuisine.',
    moneyPitch2:
      'Les applis de livraison prennent jusqu’à 30 % de chaque commande. Commander en direct, c’est laisser aux gens qui ont cuisiné ce que vous avez payé.',
    seeMenu: 'Voir le menu',
    monday: 'Lundi',
    tuesday: 'Mardi',
    wednesday: 'Mercredi',
    thursday: 'Jeudi',
    friday: 'Vendredi',
    saturday: 'Samedi',
    sunday: 'Dimanche',
  },
  kitchen: {
    title: 'Cuisine',
    loading: 'Chargement…',
    ordersOnPass: 'commandes au passe',
    soundOn: 'Son activé',
    soundOff: 'Son coupé',
    soundOnTitle: 'Le son est activé',
    soundOffTitle: 'Le son est COUPÉ — les nouvelles commandes seront silencieuses',
    fullScreen: 'Plein écran',
    soundOffBanner: 'Le son est coupé. Les nouvelles commandes arriveront en silence.',
    nothingHere: 'Rien ici',
    colNew: 'Nouvelles',
    colCooking: 'En cuisson',
    colReady: 'Prêtes',
    accept: 'Accepter',
    startPreparing: 'Commencer la préparation',
    ready: 'Prête',
    pickedUp: 'Récupérée',
    pickup: 'À emporter',
    delivery: 'Livraison',
    dineIn: 'Sur place',
    table: 'Table',
    justNow: 'à l’instant',
    noEta: 'Aucune estimation',
    anyMoment: 'D’un instant à l’autre',
    readyIn: 'Prête dans',
    min: 'min',
    newOrders: 'nouvelle(s) commande(s)',
    couldNotUpdate: 'Impossible de mettre à jour la commande',
    couldNotEta: 'Impossible de mettre à jour l’estimation',
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

/**
 * Pick the localized version of a piece of menu content: the French field when the
 * customer is in French AND a French value exists, otherwise the original. So a
 * missing translation always falls back to something readable, never a blank.
 */
export function localized(
  base: string,
  fr: string | null | undefined,
  locale: Locale,
): string {
  return locale === 'fr' && fr ? fr : base;
}
