// Achievement taxonomy types. The legacy client-side streak/achievement
// computation that lived here was dead code — achievements are computed in
// store/achievements.ts; only these type aliases are still consumed.
export type AchievementCategory = 'milestone' | 'streak' | 'discipline' | 'session' | 'consistency';
export type AchievementRarity = 'common' | 'rare' | 'epic' | 'legendary';
