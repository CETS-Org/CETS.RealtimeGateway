## Notification Service Setup & Implementation Guide

This document explains how to **set up notifications (Docker & services)** and **implement new backend notification events**.

---

### Overview

- **Storage**: MongoDB (`COM_Notifications` via `COM_Notification`).
- **Backend API**: `CETS.API.Web` exposes `/api/COM_Notification/*`.
- **Notification service**: `COM_NotificationService` in `CETS.Core`.
- **Event bus**: Redis pub/sub (`notifications` channel).
- **Realtime gateway**: `CETS.RealtimeGateway` (Socket.IO + Redis).
- **Frontend**: `CETS.FE-StudentTeacher` listens via WebSocket & REST.

Flow:  
**Backend service → `ICOM_NotificationService.Create*` → MongoDB + Redis → RealtimeGateway → FE socket → Navbar & `NotificationDialog`.**

---

## 1. Infra Setup with Docker

### 1.1 Core infra (MongoDB)

In `CETS.RealtimeGateway` folder:

```bash
cd CETS.RealtimeGateway
docker compose up -d
```

- **MongoDB**:  
  - Container: `cets_mongodb`  
  - Connection: `mongodb://guest:guest@localhost:27017`

### 1.2 Realtime notification infra (Redis)



- **Redis**:
  - Container: `cets_redis`
  - Port: `6379`
  - Used by backend (`RedisNotificationEventPublisher`) and the gateway.

---

## 2. Service Configuration

### 2.1 Backend API (`CETS.API.Web`)

- File: `CETS.API/CETS.API.Web/Program.cs`

Ensure DI is wired (already present):

```csharp
// Notifications
builder.Services.AddScoped<ICOM_NotificationService, COM_NotificationService>();
builder.Services.AddScoped<ICOM_NotificationRepository, COM_NotificationRepository>();
builder.Services.AddSingleton<INotificationEventPublisher, RedisNotificationEventPublisher>();
```

- File: `CETS.Core/Infrastructure/Implementations/Common/Notifications/RedisNotificationEventPublisher.cs`

`Redis` connection string is read from configuration:

```csharp
var redisConnection = configuration.GetConnectionString("Redis") ?? "localhost:6379";
```

Configure in `appsettings.json` or environment:

```json
{
  "ConnectionStrings": {
    "MongoDb": "mongodb://guest:guest@localhost:27017",
     "Redis": "localhost:6379"
  },
   "Mongo": {
    "Database": "CETS",
    "Notification": {
      "Collection": "notifications"
    },
    "Chat": {
      "Collection": "messages"
    }
  },
}
```

> **Note**: Mongo notification settings are bound to `MongoNotificationOptions` in `Program.cs`.

### 2.2 Realtime Gateway (`CETS.RealtimeGateway`)

- File: `CETS.RealtimeGateway/server.js`

Environment variables:

- **`REDIS_URL`** – Redis connection string, e.g. `redis://localhost:6379`
- **`ALLOWED_ORIGINS`** – comma-separated FE URLs, e.g. `http://localhost:5173`

Example `.env` in `CETS.RealtimeGateway`:

```env
REDIS_URL=redis://localhost:6379
PORT=5001
ALLOWED_ORIGINS=http://localhost:4000,http://localhost:3000
```

Run:

```bash
cd CETS.RealtimeGateway
npm install
npm run dev        # or: node server.js
```

### 2.3 Frontend (`CETS.FE-StudentTeacher`)

#### WebSocket URL

- File: `CETS.FE-StudentTeacher/.env` (create if needed)

```env
VITE_NOTIFICATION_SOCKET_URL=http://localhost:5001
```

Used in `useNotificationSocket`:

```ts
const url = import.meta.env.VITE_NOTIFICATION_SOCKET_URL || 'http://localhost:5001';
```

#### REST endpoints

- File: `CETS.FE-StudentTeacher/src/api/api.ts`

```ts
export const endpoint = {
  // ...
  notification: '/api/COM_Notification',
};
```

- File: `src/api/notification.api.ts` wraps:
  - `GET /api/COM_Notification/user/{userId}`
  - `POST /api/COM_Notification/{id}/read`
  - `POST /api/COM_Notification/user/{userId}/read-all`
  - `POST /api/COM_Notification/bulk`

#### Socket listener

- File: `src/hooks/useNotificationSocket.ts`

It connects with `userId` from `localStorage` (`getUserInfo().id`) and listens on `notification` events.

---

## 3. Notification Model & Service

### 3.1 Data contract

- DTO: `CETS.Core/DTOs/COM/COM_Notification/Requests/CreateNotificationRequest.cs`

Key properties:

- `UserId`: string (must match FE `userInfo.id`, uppercased in gateway)
- `Title`: short title (max 200 chars)
- `Message`: body text (max 4000 chars)
- `Type`: `info|warning|system|chat` (enforced via regex)
- `IsRead`: usually `false` when creating

- Entity: `Domain.Entities.MongoDB.COM_Notification`
- Response: `DTOs.COM.COM_Notification.Responses.NotificationResponse`

### 3.2 Core notification service

- Interface: `Application.Interfaces.COM/ICOM_NotificationService.cs`
- Impl: `Application.Implementations.COM/COM_NotificationService.cs`

`CreateAsync` path:

1. Map `CreateNotificationRequest` → `COM_Notification`.
2. Store in Mongo via `ICOM_NotificationRepository`.
3. Map to `NotificationResponse`.
4. Publish to Redis via `INotificationEventPublisher` (`RedisNotificationEventPublisher`).

---

## 4. How to Add Notifications in Assignment Services

Assignments are already wired as an example; use this pattern for other services.

### 4.1 Where

- File: `CETS.Core/Application/Implementations/ACAD/ACAD_AssignmentService.cs`

Injected dependencies:

```csharp
private readonly IACAD_AssignmentRepository _assignmentRepository;
private readonly IACAD_ClassMeetingRepository _classMeetingRepository;
private readonly IACAD_EnrollmentRepository _enrollmentRepository;
private readonly IFileStorageService _fileStorageService;
private readonly IUnitOfWork _unitOfWork;
private readonly IMapper _mapper;
private readonly ICOM_NotificationService _notificationService;
```

### 4.2 Helper to notify all students of a class

```csharp
private async Task NotifyStudentsAboutAssignmentAsync(ACAD_Assignment assignment, string message)
{
    if (assignment.ClassMeetingID == null) return;

    var classMeeting = await _classMeetingRepository.GetByIdAsync(assignment.ClassMeetingID.Value);
    if (classMeeting == null) return;

    var enrollments = await _enrollmentRepository.GetByClassAsync(classMeeting.ClassID);
    if (enrollments == null) return;

    var requests = enrollments
        .Where(e => e.Student?.Account != null)
        .Select(e => new CreateNotificationRequest
        {
            UserId = e.Student.Account.Id.ToString().ToUpperInvariant(),
            Title = assignment.Title ?? "New assignment",
            Message = message,
            Type = "system",
            IsRead = false
        })
        .ToList();

    if (requests.Count == 0) return;

    await _notificationService.CreateManyAsync(requests);
}
```

> **Important**: `GetByClassAsync` in `ACAD_EnrollmentRepository` includes `Student.Account` so we can access `Account.Id`.

### 4.3 When notifications are sent for assignments

In `ACAD_AssignmentService`:

- **CreateAssignmentAsync** – after saving:

```csharp
await NotifyStudentsAboutAssignmentAsync(entity, "A new assignment has been posted.");
```

- **CreateAssignmentWithFileAsync** – inside transaction, after `SaveChangesAsync`:

```csharp
await NotifyStudentsAboutAssignmentAsync(entity, "A new assignment with attached file has been posted.");
```

- **CreateQuizAssignmentAsync**:

```csharp
await NotifyStudentsAboutAssignmentAsync(entity, "A new quiz assignment has been posted.");
```

- **CreateSpeakingAssignmentAsync**:

```csharp
await NotifyStudentsAboutAssignmentAsync(entity, "A new speaking assignment has been posted.");
```

- **UpdateAssignmentAsync**:

```csharp
await NotifyStudentsAboutAssignmentAsync(entity, "An assignment has been updated.");
```

- **DeleteAssignmentAsync**:

```csharp
await NotifyStudentsAboutAssignmentAsync(entity, "An assignment has been removed.");
```

---

## 5. General Recipe for Adding Notifications in Other Services

To add notifications for any business event (e.g. grading, weekly feedback):

1. **Inject `ICOM_NotificationService`** into the application service.
2. **Identify target users**:
   - Usually via repositories (`Enrollment`, `Class`, etc.).
   - Use `Student.Account.Id` / `Account.Id` and **uppercase** for consistency.
3. **Build requests**:

```csharp
var request = new CreateNotificationRequest
{
    UserId = userId.ToString().ToUpperInvariant(),
    Title = "Short title",
    Message = "Descriptive message",
    Type = "system", // or info / warning / chat
    IsRead = false
};
```

4. **Call**:
   - `CreateAsync(request)` for single user.
   - `CreateManyAsync(requests)` for bulk.
5. **Place the call after successful DB work** (after `SaveChangesAsync` / transactional logic), so you don’t notify on failed operations.

---

## 6. Local Testing Checklist

- **Start infra**:
  - `docker compose up -d` at root (Mongo).
  - `docker compose up -d` in `CETS.RealtimeGateway` (Redis).
- **Run apps**:
  - `CETS.API.Web` (ASP.NET backend).
  - `CETS.RealtimeGateway` (Node/Socket.IO).
  - `CETS.FE-StudentTeacher` (Vite dev server).
- **Login as a student** in FE.
- Trigger assignment actions (create/update/delete) as teacher in the appropriate UI.
- Verify:
  - New entries appear via GET `/api/COM_Notification/user/{userId}`.
  - Live notifications arrive through the bell icon in the navbar without page refresh.

This pattern can be reused for any feature that needs notifications—just follow the assignment implementation as a template.