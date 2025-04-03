/** @public */
export enum CrimeType {
    shoplift = 'Shoplift',
    robStore = 'Rob Store',
    mug = 'Mug',
    larceny = 'Larceny',
    dealDrugs = 'Deal Drugs',
    bondForgery = 'Bond Forgery',
    traffickArms = 'Traffick Arms',
    homicide = 'Homicide',
    grandTheftAuto = 'Grand Theft Auto',
    kidnap = 'Kidnap',
    assassination = 'Assassination',
    heist = 'Heist',
}

/** @public */
export enum GymType {
    strength = 'str',
    defense = 'def',
    dexterity = 'dex',
    agility = 'agi',
}

/** @public */
export enum UniversityClassType {
    computerScience = 'Computer Science',
    dataStructures = 'Data Structures',
    networks = 'Networks',
    algorithms = 'Algorithms',
    management = 'Management',
    leadership = 'Leadership',
}

/**
 * Data representing the internal values of a crime.
 * @public
 */
export interface CrimeStats {
    /** Number representing the difficulty of the crime. Used for success chance calculations */
    difficulty: number;
    /** Amount of karma lost for successfully committing this crime */
    karma: number;
    /** How many people die as a result of this crime */
    kills: number;
    /** How much money is given */
    money: number;
    /** Milliseconds it takes to attempt the crime */
    time: number;
    /** Description of the crime activity */
    type: string;
    /** Impact of hacking level on success chance of the crime */
    hacking_success_weight: number;
    /** Impact of strength level on success chance of the crime */
    strength_success_weight: number;
    /** Impact of defense level on success chance of the crime */
    defense_success_weight: number;
    /** Impact of dexterity level on success chance of the crime */
    dexterity_success_weight: number;
    /** Impact of agility level on success chance of the crime */
    agility_success_weight: number;
    /** Impact of charisma level on success chance of the crime */
    charisma_success_weight: number;
    /** hacking exp gained from crime */
    hacking_exp: number;
    /** strength exp gained from crime */
    strength_exp: number;
    /** defense exp gained from crime */
    defense_exp: number;
    /** dexterity exp gained from crime */
    dexterity_exp: number;
    /** agility exp gained from crime */
    agility_exp: number;
    /** charisma exp gained from crime */
    charisma_exp: number;
    /** intelligence exp gained from crime */
    intelligence_exp: number;
}