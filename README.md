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

## Deployment to Render

Render is a cloud platform that makes it easy to deploy web services. This guide will walk you through deploying your wedding invitation app to Render.

### Prerequisites

- A GitHub account
- Your code pushed to a GitHub repository
- A Render account (sign up at [render.com](https://render.com))

### Step 1: Prepare Your Repository

1. Make sure your code is committed and pushed to GitHub
2. Verify that `render.yaml` is in the root of your repository
3. Ensure `package.json` includes the Node.js version specification

### Step 2: Create a New Web Service on Render

1. Log in to your [Render Dashboard](https://dashboard.render.com/)
2. Click **"New +"** and select **"Web Service"**
3. Connect your GitHub account if you haven't already
4. Select your repository: `wedding-invite-app`
5. Render will detect the `render.yaml` file and use those settings
6. Give your service a name (e.g., "wedding-invite-app")
7. Click **"Create Web Service"**

### Step 3: Configure Environment Variables

In the Render dashboard, go to your service's **Environment** tab and add the following environment variables:

**Required Variables:**

- `GOOGLE_SERVICE_ACCOUNT_KEY`: Your full Google service account JSON key as a single-line string. Copy the entire JSON content from your downloaded service account key file.
  
  Example format:
  ```
  {"type":"service_account","project_id":"your-project","private_key_id":"...","private_key":"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n","client_email":"...","client_id":"...","auth_uri":"...","token_uri":"...","auth_provider_x509_cert_url":"...","client_x509_cert_url":"..."}
  ```

- `GOOGLE_GUEST_SHEET_ID`: The ID of your Google Sheet containing the guest list (extract from the Sheet URL)

- `GOOGLE_RESPONSE_SHEET_ID`: The ID of your Google Sheet for RSVP responses (extract from the Sheet URL)

- `RSVP_BASE_URL`: Your Render service URL (e.g., `https://your-app-name.onrender.com`). **Important**: Update this after deployment with your actual Render URL.

**Optional Variables:**

- `INVITATION_MESSAGE`: Custom invitation message (defaults to a standard message if not set)

**Note**: The `PORT` variable is automatically set by Render - you don't need to configure it.

### Step 4: Deploy

1. After setting all environment variables, Render will automatically start building and deploying your service
2. Monitor the build logs in the Render dashboard
3. Once deployment succeeds, your service will be available at `https://your-app-name.onrender.com`

### Step 5: Configure WhatsApp (After First Deployment)

**Important**: Render uses an ephemeral filesystem, which means WhatsApp session data stored in `.wwebjs_auth_*` folders will be **lost whenever the service restarts or redeploys**. You will need to re-authenticate WhatsApp after each deployment or restart.

1. After your first deployment, visit your admin panel at: `https://your-app-name.onrender.com/admin.html`
2. Enter a sender name (as configured in your Google Sheet)
3. Click **"Initialize WhatsApp"**
4. A QR code will appear on the page
5. Open WhatsApp on your phone
6. Go to **Settings** > **Linked Devices** > **Link a Device**
7. Scan the QR code displayed on the admin panel
8. Your WhatsApp session will be active until the service restarts

### Step 6: Update RSVP_BASE_URL

1. After deployment, copy your Render service URL (e.g., `https://your-app-name.onrender.com`)
2. Go to your service's **Environment** tab in Render dashboard
3. Update `RSVP_BASE_URL` to your actual Render URL
4. Save and redeploy (Render will automatically redeploy when you save environment variables)

### Important Notes for Render Deployment

- **WhatsApp Sessions**: Since Render's filesystem is ephemeral, WhatsApp sessions will be lost on restart/redeploy. You'll need to scan the QR code again via the admin panel after each deployment or restart.

- **Auto-Deployments**: Render can automatically deploy when you push to your GitHub repository. Configure this in your service settings if desired.

- **Free Tier Limitations**: On Render's free tier, services spin down after 15 minutes of inactivity. This means:
  - Your service may take 30-60 seconds to start when accessed after inactivity
  - WhatsApp sessions will be lost when the service spins down
  - Consider upgrading to a paid plan for persistent services

- **Health Checks**: The service includes a `/health` endpoint that Render uses to verify the service is running.

### Memory Management on Render

The app includes several memory optimizations to prevent exceeding Render's memory limits:

- **Node.js Memory Limit**: Limited to 512MB via `--max-old-space-size=512`
- **Puppeteer Optimizations**: Many Chromium features disabled to reduce memory usage
- **Automatic Cleanup**: 
  - QR codes are cleared from memory after client is ready
  - Inactive clients are cleaned up every 15 minutes
  - Memory usage is logged every 5 minutes

**If you still encounter memory issues:**

1. **Upgrade Render Plan**: Free tier has limited memory (512MB). Consider upgrading to a paid plan with more memory
2. **Monitor Memory Usage**: Check Render logs for memory usage statistics
3. **Reduce Concurrent Clients**: Only initialize WhatsApp for one sender at a time
4. **Restart Service**: If memory usage gets too high, manually restart the service in Render dashboard

### Troubleshooting Render Deployment

- **Build Fails**: Check the build logs in Render dashboard. Common issues:
  - Missing dependencies in `package.json`
  - Node.js version incompatibility
  - Build errors in your code

- **Service Won't Start**: Check the runtime logs:
  - Missing environment variables
  - Port binding issues (though PORT is auto-set by Render)
  - Google Sheets authentication errors

- **WhatsApp QR Code Not Appearing**: 
  - Check that all environment variables are set correctly
  - Verify the admin panel is accessible at `/admin.html`
  - Check Render logs for initialization errors

- **Service Spins Down (Free Tier)**: This is normal behavior on Render's free tier. Services automatically wake up when accessed, but WhatsApp sessions will be lost.

- **Memory Limit Exceeded**: 
  - Check the "Memory Management on Render" section above
  - Review Render logs for memory usage patterns
  - Consider upgrading to a paid plan with more memory
  - Ensure only one WhatsApp client is initialized at a time

### Production Recommendations

For production use, consider:

1. **Upgrading to a Paid Plan**: Prevents service spin-down and session loss
2. **Using External Storage**: Store WhatsApp sessions in external storage (S3, Render Disk) for persistence across deployments
3. **Adding Authentication**: Protect the admin panel with authentication
4. **Rate Limiting**: Add rate limiting to API endpoints
5. **Monitoring**: Set up monitoring and alerting for your service

## License

MIT

## Support

For issues or questions, please check the troubleshooting section or create an issue in the repository.

---

Made with 💕 for your special day!

