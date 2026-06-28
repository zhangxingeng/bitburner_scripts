export const CrimeType = {
    shoplift: 'Shoplift',
    robStore: 'Rob Store',
    mug: 'Mug',
    larceny: 'Larceny',
    dealDrugs: 'Deal Drugs',
    bondForgery: 'Bond Forgery',
    traffickArms: 'Traffick Arms',
    homicide: 'Homicide',
    grandTheftAuto: 'Grand Theft Auto',
    kidnap: 'Kidnap',
    assassination: 'Assassination',
    heist: 'Heist',
} as const;
export type CrimeType = (typeof CrimeType)[keyof typeof CrimeType];

export const GymType = {
    strength: 'str',
    defense: 'def',
    dexterity: 'dex',
    agility: 'agi',
} as const;
export type GymType = (typeof GymType)[keyof typeof GymType];

export const UniversityClassType = {
    computerScience: 'Computer Science',
    dataStructures: 'Data Structures',
    networks: 'Networks',
    algorithms: 'Algorithms',
    management: 'Management',
    leadership: 'Leadership',
} as const;
export type UniversityClassType = (typeof UniversityClassType)[keyof typeof UniversityClassType];

export interface CrimeStats {
    difficulty: number;
    karma: number;
    kills: number;
    money: number;
    time: number;
    type: string;
    hacking_success_weight: number;
    strength_success_weight: number;
    defense_success_weight: number;
    dexterity_success_weight: number;
    agility_success_weight: number;
    charisma_success_weight: number;
    hacking_exp: number;
    strength_exp: number;
    defense_exp: number;
    dexterity_exp: number;
    agility_exp: number;
    charisma_exp: number;
    intelligence_exp: number;
}
