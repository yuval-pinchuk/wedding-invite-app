# Wedding Invitation App 💕

An automated WhatsApp wedding invitation system that reads guest lists from Google Sheets, sends personalized invitations via WhatsApp, and collects RSVPs through a beautiful landing page.

## Features

- 📋 **Google Sheets Integration**: Read guest lists and automatically update RSVP responses
- 📱 **WhatsApp Integration**: Send invitations via WhatsApp Web.js (FREE, no API costs!)
- 🎨 **Beautiful RSVP Landing Page**: Modern, responsive design for guest responses
- ⚡ **Automated Workflow**: Send invitations to all guests with a single command
- 📊 **Response Tracking**: All RSVPs automatically saved to Google Sheets

## Prerequisites

1. **Node.js** (v16 or higher)
2. **Google Cloud Project** with Sheets API enabled
3. **WhatsApp account** (your personal WhatsApp - no API keys needed!)
4. **Two Google Sheets**:
   - Guest list sheet (Name, PhoneTo, PhoneFrom)
   - Response sheet (will be auto-populated)

## Setup Instructions

### 1. Install Dependencies

```bash
npm install
```

### 2. Google Sheets Setup

#### Create a Service Account

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. Enable the **Google Sheets API**
4. Go to **IAM & Admin** > **Service Accounts**
5. Click **Create Service Account**
6. Give it a name (e.g., "wedding-invite-service")
7. Click **Create and Continue**, then **Done**
8. Click on the created service account
9. Go to the **Keys** tab
10. Click **Add Key** > **Create new key** > **JSON**
11. Download the JSON file

#### Prepare Your Google Sheets

**Guest List Sheet** (columns: Name, PhoneTo, PhoneFrom):
```
Name          | PhoneTo        | PhoneFrom
John Doe      | +1234567890    | +1987654321
Jane Smith    | +1234567891    | +1987654321
```

**Response Sheet** (will be auto-populated):
- Headers will be created automatically: Name, Phone, RSVP Status, Number of Guests, Timestamp

#### Share Sheets with Service Account

1. Open both Google Sheets
2. Click **Share** button
3. Add the service account email (from the JSON file, `client_email` field)
4. Give it **Editor** permissions
5. Copy the Sheet IDs from the URLs:
   - `https://docs.google.com/spreadsheets/d/SHEET_ID_HERE/edit`

### 3. WhatsApp Setup (FREE!)

**No API keys or accounts needed!** This app uses WhatsApp Web.js, which connects to WhatsApp Web (just like WhatsApp Web in your browser).

**First-time setup:**
1. When you run `npm run send:invitations` for the first time, a QR code will appear in your terminal
2. Open WhatsApp on your phone
3. Go to **Settings** > **Linked Devices** > **Link a Device**
4. Scan the QR code shown in your terminal
5. The session will be saved automatically - you won't need to scan again!

**Important Notes:**
- ⚠️ This uses an unofficial WhatsApp library (WhatsApp Web.js)
- ⚠️ It may violate WhatsApp's Terms of Service (use at your own risk)
- ⚠️ Your WhatsApp account could potentially be banned if used improperly
- ✅ It's completely FREE - no per-message costs!
- ✅ Works with your personal WhatsApp account
- ✅ Session persists - only need to scan QR code once

### 4. Environment Configuration

1. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```

2. Edit `.env` and fill in your credentials:

   **Option A: Full Service Account Key (Recommended)**
   ```env
   GOOGLE_SERVICE_ACCOUNT_KEY={"type":"service_account",...}
   ```
   Paste the entire JSON content from your downloaded service account key file.

   **Option B: Individual Credentials**
   ```env
   GOOGLE_CLIENT_EMAIL=your-service-account@project.iam.gserviceaccount.com
   GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
   ```

   **Sheet IDs:**
   ```env
   GOOGLE_GUEST_SHEET_ID=your-guest-list-sheet-id
   GOOGLE_RESPONSE_SHEET_ID=your-response-sheet-id
   ```

   **Customization:**
   ```env
   INVITATION_MESSAGE=You're invited to our wedding! 🎉\n\nWe would love to celebrate this special day with you.
   RSVP_BASE_URL=http://localhost:8080
   ```

## Usage

### Start the Server

```bash
npm start
```

Or for development with auto-reload:

```bash
npm run dev
```

The server will run on `http://localhost:8080` (or your configured PORT).

### Send Invitations

To send WhatsApp invitations to all guests in your sheet:

```bash
npm run send:invitations
```

The script will:
1. Initialize WhatsApp client (scan QR code on first run)
2. Read all guests from your Google Sheet
3. Show you a preview
4. Wait 5 seconds (press Ctrl+C to cancel)
5. Send invitations via WhatsApp
6. Show a summary of successful/failed sends

### RSVP Landing Page

Guests will receive a WhatsApp message with a link to your RSVP page. They can:
- Enter their name and phone number
- Indicate if they're attending
- Specify number of guests
- Submit their RSVP

All responses are automatically saved to your response Google Sheet.

## Project Structure

```
wedding-invite-app/
├── server/
│   ├── app.js              # Express server setup
│   ├── routes/
│   │   └── rsvp.js         # RSVP API endpoints
│   └── services/
│       ├── googleSheets.js # Google Sheets read/write
│       └── whatsapp.js    # WhatsApp Web.js integration (FREE)
├── scripts/
│   └── sendInvitations.js # Script to send invitations
├── public/
│   └── index.html         # RSVP landing page
├── .env.example           # Environment template
└── package.json
```

## Customization

### Custom Invitation Message

Edit the `INVITATION_MESSAGE` in your `.env` file or modify it in `scripts/sendInvitations.js`.

### Custom RSVP Link

You can customize the RSVP link to include guest-specific information:

1. Modify `scripts/sendInvitations.js` to include phone number in the link:
   ```javascript
   const rsvpLink = `${rsvpBaseUrl}?phone=${encodeURIComponent(guest.phoneTo)}`;
   ```

2. The landing page already supports a `?phone=` parameter to pre-fill the phone field.

### Styling

Edit `public/index.html` to customize the landing page design, colors, and messaging.

## Troubleshooting

### Google Sheets Errors

- **"Permission denied"**: Make sure you've shared the sheets with the service account email
- **"Sheet not found"**: Verify the Sheet IDs in your `.env` file
- **"API not enabled"**: Enable Google Sheets API in Google Cloud Console

### WhatsApp Errors

- **"QR code not scanning"**: Make sure your phone and computer are on the same network, and try again
- **"Client disconnected"**: Your WhatsApp session may have expired - delete `.wwebjs_auth` folder and scan QR code again
- **"Message failed to send"**: Check that the phone number is correct (format: country code + number, e.g., `1234567890` for US)
- **"Rate limit"**: The script includes delays between messages (3 seconds); increase if needed
- **Account banned warning**: Using unofficial WhatsApp APIs can risk account bans - use responsibly and don't send spam

### General Issues

- Check that all environment variables are set correctly
- Verify Node.js version (v16+)
- Check server logs for detailed error messages

## Security Notes

- Never commit your `.env` file to version control
- Keep your service account keys secure
- The `.wwebjs_auth` folder contains your WhatsApp session - keep it secure and don't share it
- **Important**: WhatsApp Web.js is unofficial and may violate WhatsApp's Terms of Service
- Use responsibly - don't send spam or bulk messages that could get your account banned
- Consider using the official WhatsApp Business API for production/commercial use

## CodeRabbit Integration 🤖

CodeRabbit provides AI-powered code reviews for your pull requests. The repository is already configured with a `.coderabbit.yaml` file.

### Setup CodeRabbit

1. **Install CodeRabbit GitHub App:**
   - Visit [CodeRabbit.ai](https://coderabbit.ai/)
   - Click "Login with GitHub"
   - Authorize CodeRabbit to access your repositories
   - Select your repository: `wedding-invite-app`

2. **Enable for Your Repository:**
   - Go to your repository settings on GitHub
   - Navigate to **Settings** > **Integrations** > **Installed GitHub Apps**
   - Find CodeRabbit and configure it
   - Ensure it's enabled for pull request reviews

3. **Configuration:**
   - The repository includes a `.coderabbit.yaml` configuration file
   - CodeRabbit will automatically review pull requests
   - You can interact with CodeRabbit in PR comments using commands like `/review`, `/summarize`, `/explain`

### CodeRabbit Features

- **Automated Reviews**: CodeRabbit automatically reviews pull requests and provides feedback
- **Interactive Chat**: Ask questions or request clarifications directly in PR comments
- **Code Quality Checks**: ESLint suggestions, security checks, and code quality analysis
- **Smart Summaries**: Get concise summaries of code changes

For more information, visit the [CodeRabbit Documentation](https://docs.coderabbit.ai/).

## Production Deployment

For production:

1. Deploy to a hosting service (Heroku, Railway, Render, etc.)
2. Set environment variables in your hosting platform
3. Update `RSVP_BASE_URL` to your production domain
4. Use HTTPS for the RSVP links
5. Consider adding rate limiting and authentication

## License

MIT

## Support

For issues or questions, please check the troubleshooting section or create an issue in the repository.

---

Made with 💕 for your special day!

