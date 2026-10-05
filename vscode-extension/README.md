# Yemot Hooks — תוסף VS Code

הדלקה, כיבוי והגדרה של ה-hooks של ימות (צינתוק / מענה טלפוני) ב-`~/.claude/settings.json`, מתוך VS Code.
עובד גם מקומית וגם ב-Remote-SSH: התוסף רץ בצד המכונה שבה רץ Claude Code (`extensionKind: workspace`),
ולכן הוא עורך את `settings.json` של השרת המרוחק ולא של המחשב שלך.

## מה יש בו

בשורת הסטטוס: **ימות: פעיל / כבוי / לא מוגדר**. לחיצה פותחת תפריט:

| פעולה | מה היא עושה |
|---|---|
| **הדלק / כבה** | כיבוי מוציא את ה-hooks של ימות מ-`settings.json` ושומר אותם ב-`~/.claude/yemot-hooks.json`; הדלקה מחזירה אותם. hooks אחרים לא נוגעים. |
| **פתח את דף ההגדרה** | פותח את `yemot_hooks_config.html` בדפדפן (המקומי שלך, גם ב-Remote-SSH). |
| **ייבא hooks מהלוח** | אחרי "העתק בלוק hooks" בדף ההגדרה — מחליף את ה-hooks של ימות ב-`settings.json` ומדליק. |
| **הגדר טוקן ימות** | שומר `env.YEMOT_TOKEN` ב-`settings.json` (קובץ בהרשאה 600), ל-hooks של צינתוק שקוראים `$env:YEMOT_TOKEN`. |
| **בדיקת שרת** | `GET …/health` של הגשר: האם השרת זמין, יש לו טוקן, וכמה שאלות ממתינות. |
| הצג hooks / פתח settings.json | לראות מה מוגדר בפועל. |

ה-hooks "שלנו" מזוהים בדיוק כמו בדף ההגדרה: כל hook שהפקודה שלו פונה ל-`RunTzintuk` או ל-`/ask-hook`.

## הגדרות

| הגדרה | ברירת מחדל | |
|---|---|---|
| `yemotHooks.serverUrl` | ריק (יישאל בשימוש הראשון) | כתובת השרת שמריץ את הגשר, בלי `/claude-hooks`. |
| `yemotHooks.configUrl` | ריק | כתובת מלאה לדף ההגדרה. ריק = `<serverUrl>/claude-hooks/config` (כשהגשר רץ בתוך yemot-suite). עם `main.py` העצמאי — היכן שמתארח `yemot_hooks_config.html` (למשל GitHub Pages). |
| `yemotHooks.settingsFile` | `~/.claude/settings.json` | קובץ ההגדרות של Claude Code. |

## התקנה

```bash
cd vscode-extension
npx @vscode/vsce package --allow-missing-repository --skip-license -o yemot-hooks.vsix
```

ב-VS Code: **Extensions ← ⋯ ← Install from VSIX…**. ב-Remote-SSH — מתוך החלון המחובר, כך שיותקן בצד השרת.

## הערות

- שינוי hooks חל על **שיחות Claude חדשות**. שיחה שכבר רצה ממשיכה עם ההגדרות שהיו כשהתחילה.
- ה-hooks שהדף מייצר הם `"shell": "powershell"`. ב-**Linux / Mac** צריך PowerShell 7 (`pwsh`) ב-PATH — Claude Code מריץ אותם דרכו.
- בדיקות: `node test.js` (מריץ הדלקה/כיבוי/ייבוא מול `HOME` זמני).
